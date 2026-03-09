import { type SystemEvent } from '@ai-hivemind/shared';

import { translateEvent } from '@/lib/eventTranslator';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentStats {
    eventCount: number;
    /** Number of events that are visible (non-null translateEvent) */
    visibleCount: number;
    toolCalls: number;
    firstTimestamp: string;
    lastTimestamp: string;
    status: 'running' | 'completed' | 'failed';
}

export interface AgentNode {
    /** Full agent ID, e.g. "swe-agent.abc123" */
    agentId: string;
    /** Role prefix, e.g. "swe-agent" */
    role: string;
    /** Human-readable display name, e.g. "Software Engineer" */
    displayName: string;
    /** All events where sourceId === agentId */
    events: SystemEvent[];
    /** Child agents (inferred from hierarchy) */
    children: AgentNode[];
    /** Computed stats */
    stats: AgentStats;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maps agent role → human-readable display name */
const ROLE_DISPLAY_NAMES: Record<string, string> = {
    'feature-developer': 'Feature Developer',
    'project-manager': 'Project Manager',
    'data-researcher': 'Data Researcher',
    'site-explorer': 'Site Explorer',
    'ux-designer': 'UX Designer',
    'swe-agent': 'Software Engineer',
    'qa-engineer': 'QA Engineer',
    'nerve-center': 'System',
};

/**
 * Maps child role → expected parent role.
 * All AGENT_SPAWNED events have targetId=null (agents spawn themselves),
 * so we use this static map to reconstruct the hierarchy.
 */
const ROLE_PARENT_MAP: Record<string, string> = {
    'data-researcher': 'feature-developer',
    'site-explorer': 'feature-developer',
    'ux-designer': 'feature-developer',
    'swe-agent': 'feature-developer',
    'qa-engineer': 'feature-developer',
    // Legacy: support old events where agents were children of project-manager
    'project-manager': 'feature-developer',
};

/** Roles that should be expanded by default */
const DEFAULT_EXPANDED_ROLES = new Set(['feature-developer', 'project-manager']);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract role prefix from an agent ID (e.g. "swe-agent.abc123" → "swe-agent") */
function extractRole(agentId: string): string {
    const dotIdx = agentId.indexOf('.');
    return dotIdx > 0 ? agentId.slice(0, dotIdx) : agentId;
}

/** Get display name for a role, with optional depth indicator for sub-PMs */
function getDisplayName(role: string, isSubPm = false): string {
    const base = ROLE_DISPLAY_NAMES[role] ?? role;
    if (role === 'project-manager' && isSubPm) {
        return 'Sub-PM';
    }
    return base;
}

/** Compute stats for an agent from its events */
function computeStats(events: SystemEvent[]): AgentStats {
    let toolCalls = 0;
    let visibleCount = 0;
    let status: AgentStats['status'] = 'running';

    for (const event of events) {
        if (event.eventType === 'TOOL_USED') toolCalls++;
        if (translateEvent(event) !== null) visibleCount++;
        if (event.eventType === 'AGENT_TERMINATED') {
            const reason = typeof event.payload['reason'] === 'string'
                ? event.payload['reason']
                : '';
            status = reason.toLowerCase().includes('error') || reason.toLowerCase().includes('fail')
                ? 'failed'
                : 'completed';
        }
        if (event.eventType === 'ERROR') {
            status = 'failed';
        }
    }

    const first = events[0];
    const last = events[events.length - 1];

    return {
        eventCount: events.length,
        visibleCount,
        toolCalls,
        firstTimestamp: first?.timestamp ?? '',
        lastTimestamp: last?.timestamp ?? '',
        status,
    };
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Transforms a flat list of events (for a single feature/traceId) into a
 * hierarchical tree of agents with their events grouped under them.
 *
 * Returns root-level AgentNodes (agents with no parent in this trace).
 */
export function buildAgentTree(events: SystemEvent[]): AgentNode[] {
    // 1. Group events by sourceId
    const eventsByAgent = new Map<string, SystemEvent[]>();
    for (const event of events) {
        const agentId = event.sourceId;
        const list = eventsByAgent.get(agentId);
        if (list !== undefined) {
            list.push(event);
        } else {
            eventsByAgent.set(agentId, [event]);
        }
    }

    // 2. Extract explicit parentAgentId from AGENT_SPAWNED events (for hierarchical PM support)
    const explicitParents = new Map<string, string>();
    for (const [agentId, agentEvents] of eventsByAgent) {
        const spawnEvent = agentEvents.find((e) => e.eventType === 'AGENT_SPAWNED');
        if (spawnEvent === undefined) continue;
        const parentAgentId = typeof spawnEvent.payload['parentAgentId'] === 'string'
            ? spawnEvent.payload['parentAgentId']
            : null;
        if (parentAgentId !== null) {
            explicitParents.set(agentId, parentAgentId);
        }
    }

    // 3. Create AgentNode for each unique sourceId
    const nodeMap = new Map<string, AgentNode>();
    for (const [agentId, agentEvents] of eventsByAgent) {
        const role = extractRole(agentId);
        const stats = computeStats(agentEvents);

        // Skip agents with no visible events (e.g., "user" sourceId
        // for USER_COMMAND/USER_INTERVENTION events shown in chat, not activity)
        if (stats.visibleCount === 0 && agentEvents.length > 0) continue;

        const isSubPm = role === 'project-manager' && explicitParents.has(agentId);
        nodeMap.set(agentId, {
            agentId,
            role,
            displayName: getDisplayName(role, isSubPm),
            events: agentEvents,
            children: [],
            stats,
        });
    }

    // 4. Build parent-child relationships
    //
    // Priority: explicit parentAgentId from AGENT_SPAWNED payload (supports
    // hierarchical PM spawning) → static ROLE_PARENT_MAP fallback (backward compat).

    // Build a role→agentId index for static fallback (only for agents without explicit parent).
    // If multiple agents share a role (e.g., two PMs), use the earliest one.
    const roleIndex = new Map<string, string>();
    for (const agentId of nodeMap.keys()) {
        if (explicitParents.has(agentId)) continue; // skip — has explicit parent
        const role = extractRole(agentId);
        if (!roleIndex.has(role)) {
            roleIndex.set(role, agentId);
        }
    }

    const childToParent = new Map<string, string>();
    for (const agentId of nodeMap.keys()) {
        // 1. Try explicit parentAgentId from spawn event
        const explicitParent = explicitParents.get(agentId);
        if (explicitParent !== undefined && nodeMap.has(explicitParent)) {
            childToParent.set(agentId, explicitParent);
            continue;
        }

        // 2. Fallback to static ROLE_PARENT_MAP
        const role = extractRole(agentId);
        const parentRole = ROLE_PARENT_MAP[role];
        if (parentRole === undefined) continue; // root-level agent

        // For agents with an explicit parent PM, find that PM's agentId
        // Otherwise use the first PM in the role index
        const parentId = roleIndex.get(parentRole);
        if (parentId !== undefined && nodeMap.has(parentId)) {
            childToParent.set(agentId, parentId);
        }
    }

    // 5. Wire up children
    for (const [childId, parentId] of childToParent) {
        const parent = nodeMap.get(parentId);
        const child = nodeMap.get(childId);
        if (parent !== undefined && child !== undefined) {
            parent.children.push(child);
        }
    }

    // Sort children by first event timestamp
    for (const node of nodeMap.values()) {
        node.children.sort((a, b) =>
            a.stats.firstTimestamp.localeCompare(b.stats.firstTimestamp),
        );
    }

    // 6. Collect root nodes (nodes that are NOT children of anyone)
    const childIds = new Set(childToParent.keys());
    const roots: AgentNode[] = [];
    for (const [agentId, node] of nodeMap) {
        if (!childIds.has(agentId)) {
            roots.push(node);
        }
    }

    // Sort roots by first event timestamp
    roots.sort((a, b) =>
        a.stats.firstTimestamp.localeCompare(b.stats.firstTimestamp),
    );

    return roots;
}

/** Whether an agent role should be expanded by default */
export function isDefaultExpanded(role: string): boolean {
    return DEFAULT_EXPANDED_ROLES.has(role);
}
