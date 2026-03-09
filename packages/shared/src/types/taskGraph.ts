import { z } from 'zod';

/**
 * taskGraph.ts — Task Graph types for the AI Hivemind orchestration engine.
 *
 * A TaskGraph is a DAG of TaskNodes. The DialogueAgent owns the graph and
 * creates/updates tasks directly based on conversation. The FeatureDeveloper
 * executes tasks sequentially, respecting dependsOn edges.
 *
 * Task lifecycle:
 *   locked  → DialogueAgent is actively reconsidering this task
 *   ready   → dependencies met, cleared for execution by FeatureDeveloper
 *   pending → waiting for upstream dependencies to complete
 *   active  → currently being executed by FeatureDeveloper
 *   blocked → waiting for user input (QA arbiter escalated)
 *   done    → completed successfully (verified by QA)
 *   failed  → failed after all retries exhausted
 *   skipped → skipped because a dependency failed
 *
 * State is kept in-memory and mirrored to the event bus as TASK_GRAPH_UPDATED events.
 */

export const TaskStatusSchema = z.enum([
    'locked',    // DialogueAgent is actively reconsidering this task
    'ready',     // dependencies met, cleared for execution
    'pending',   // waiting for dependencies to complete
    'active',    // currently being executed
    'blocked',   // waiting for user input (QA arbiter escalated)
    'done',      // completed successfully
    'failed',    // failed after all retries exhausted
    'skipped',   // skipped because a dependency failed
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTypeSchema = z.enum(['frontend', 'backend', 'fullstack']);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/**
 * Zod schema for wire-level validation. The `subGraph` field is typed as
 * `z.unknown()` at the schema level because Zod can't express recursive
 * types cleanly. The TypeScript `TaskNode` interface below provides full
 * recursive type safety at compile time.
 */
export const TaskNodeSchema = z.object({
    /** Unique identifier within this graph, e.g. "task-1", "task-2.3" */
    id: z.string(),

    /** Full, self-contained description of what this task should accomplish */
    objective: z.string(),

    /** Specific, verifiable criteria for QA to validate against */
    acceptanceCriteria: z.string(),

    /** IDs of nodes that must reach 'done' before this node can start */
    dependsOn: z.array(z.string()),

    /** Current execution status */
    status: TaskStatusSchema,

    /**
     * true  → leaf task: send to Conductor for implementation
     * false → composite: can be decomposed further by FeatureDeveloper
     */
    isAtomic: z.boolean(),

    /**
     * What kind of work this node does — used to filter context:
     *   'frontend'  → gets UX design spec, no backend-only docs
     *   'backend'   → gets API/service context, no design spec
     *   'fullstack' → gets everything
     */
    taskType: TaskTypeSchema.default('fullstack'),

    /** Human-readable result summary, set on completion */
    result: z.string().optional(),

    /** Error message, set on failure */
    error: z.string().optional(),

    /** Number of QA retry attempts used */
    attempts: z.number().optional(),

    /**
     * Whether this node is complex enough to warrant sub-task decomposition.
     * When true, the FeatureDeveloper may create a subGraph instead of
     * executing directly via SWE+QA.
     */
    delegatable: z.boolean().optional(),

    /** Agent ID that is handling this node (set at runtime when delegated) */
    delegatedTo: z.string().optional(),

    /** Child task graph for sub-task decomposition (recursive — validated at runtime) */
    subGraph: z.unknown().optional(),
});

/** Full recursive TaskNode type (compile-time type safety) */
export interface TaskNode {
    id: string;
    objective: string;
    acceptanceCriteria: string;
    dependsOn: string[];
    status: TaskStatus;
    isAtomic: boolean;
    taskType: TaskType;
    result?: string;
    error?: string;
    attempts?: number;
    delegatable?: boolean;
    delegatedTo?: string;
    subGraph?: TaskGraph;
}

export const TaskGraphSchema = z.object({
    /** The top-level user objective that spawned this graph */
    rootObjective: z.string(),

    /** Ordered list of nodes; execution respects dependsOn edges */
    nodes: z.array(TaskNodeSchema),

    /** ISO timestamp of when this graph was created */
    createdAt: z.string(),

    /** Overall graph status — derived from node statuses */
    status: TaskStatusSchema,

    /** Agent ID of the owner that manages this graph */
    ownerAgentId: z.string().optional(),

    /** Nesting depth in the hierarchy (0 = root) */
    depth: z.number().int().min(0).optional(),

    /** ID of the parent node that spawned this sub-graph (null for root) */
    parentNodeId: z.string().optional(),
});

/** Full recursive TaskGraph type (compile-time type safety) */
export interface TaskGraph {
    rootObjective: string;
    nodes: TaskNode[];
    createdAt: string;
    status: TaskStatus;
    ownerAgentId?: string;
    depth?: number;
    parentNodeId?: string;
}

/**
 * Context bundle passed from DialogueAgent to FeatureDeveloper.
 * Contains all gathered information needed to execute the task graph.
 */
export const FeatureContextSchema = z.object({
    taskGraph: TaskGraphSchema,
    researchSummary: z.string(),
    designSpec: z.unknown().nullable(),
    workObjective: z.string(),
});
export type FeatureContext = z.infer<typeof FeatureContextSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true when all dependencies of a node are in 'done' status */
export function dependenciesMet(node: TaskNode, graph: TaskGraph): boolean {
    if (node.dependsOn.length === 0) return true;
    return node.dependsOn.every((depId) => {
        const dep = graph.nodes.find((n) => n.id === depId);
        return dep?.status === 'done';
    });
}

/** Returns true when any dependency of a node has failed or been skipped */
export function dependencyFailed(node: TaskNode, graph: TaskGraph): boolean {
    return node.dependsOn.some((depId) => {
        const dep = graph.nodes.find((n) => n.id === depId);
        return dep?.status === 'failed' || dep?.status === 'skipped';
    });
}

/** Derive the overall graph status from its nodes */
export function deriveGraphStatus(graph: TaskGraph): TaskStatus {
    const statuses = graph.nodes.map((n) => n.status);
    if (statuses.some((s) => s === 'failed')) return 'failed';
    if (statuses.every((s) => s === 'done')) return 'done';
    if (statuses.some((s) => s === 'active' || s === 'blocked')) return 'active';
    // locked/ready/pending all count as "in progress but not active"
    if (statuses.some((s) => s === 'locked' || s === 'ready')) return 'active';
    return 'pending';
}

/**
 * Lock all mutable (non-terminal, non-active) tasks in the graph.
 * Called by DialogueAgent before processing a user message so the
 * FeatureDeveloper doesn't pick up tasks that might change.
 */
export function lockMutableTasks(graph: TaskGraph): void {
    for (const node of graph.nodes) {
        if (node.status === 'ready' || node.status === 'pending') {
            node.status = 'locked';
        }
    }
}

/**
 * Unlock tasks: recompute ready/pending based on dependencies.
 * Called by DialogueAgent after it finishes processing a user message.
 */
export function unlockTasks(graph: TaskGraph): void {
    for (const node of graph.nodes) {
        if (node.status === 'locked') {
            node.status = dependenciesMet(node, graph) ? 'ready' : 'pending';
        }
    }
}

/**
 * Append new nodes to a running graph. Only adds — never modifies existing nodes.
 * Validates that all dependsOn references point to existing node IDs.
 * New nodes are set to 'locked' (caller should unlockTasks after all mutations).
 */
export function appendNodes(graph: TaskGraph, newNodes: TaskNode[]): void {
    const existingIds = new Set(graph.nodes.map((n) => n.id));

    for (const node of newNodes) {
        if (existingIds.has(node.id)) {
            throw new Error(`Node "${node.id}" already exists in the graph`);
        }
        for (const depId of node.dependsOn) {
            if (!existingIds.has(depId)) {
                throw new Error(`Node "${node.id}" depends on unknown node "${depId}"`);
            }
        }
        // New nodes start locked; unlockTasks() will set ready/pending
        node.status = 'locked';
        graph.nodes.push(node);
        existingIds.add(node.id);
    }
}

/**
 * Update the objective and/or acceptance criteria of a mutable node.
 * Accepts nodes in pending, locked, or ready status.
 * Throws if the node does not exist or is in a terminal/active status.
 */
export function updateMutableNode(
    graph: TaskGraph,
    nodeId: string,
    patch: { objective?: string; acceptanceCriteria?: string },
): void {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node === undefined) {
        throw new Error(`Node "${nodeId}" not found in graph`);
    }
    const mutableStatuses = new Set<TaskStatus>(['pending', 'locked', 'ready']);
    if (!mutableStatuses.has(node.status)) {
        throw new Error(`Cannot modify node "${nodeId}" — status is "${node.status}"`);
    }
    if (patch.objective !== undefined) {
        node.objective = patch.objective;
    }
    if (patch.acceptanceCriteria !== undefined) {
        node.acceptanceCriteria = patch.acceptanceCriteria;
    }
}

/**
 * Remove a node from the graph by ID. Only allows removing mutable nodes.
 * Also removes the node from any dependsOn arrays of other nodes.
 */
export function removeMutableNode(graph: TaskGraph, nodeId: string): void {
    const idx = graph.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) {
        throw new Error(`Node "${nodeId}" not found in graph`);
    }
    const node = graph.nodes[idx]!;
    const mutableStatuses = new Set<TaskStatus>(['pending', 'locked', 'ready']);
    if (!mutableStatuses.has(node.status)) {
        throw new Error(`Cannot remove node "${nodeId}" — status is "${node.status}"`);
    }
    graph.nodes.splice(idx, 1);
    // Clean up dependency references
    for (const other of graph.nodes) {
        other.dependsOn = other.dependsOn.filter((id) => id !== nodeId);
    }
}

/**
 * Legacy alias — delegates to updateMutableNode for backward compatibility.
 * @deprecated Use updateMutableNode instead.
 */
export function updatePendingNode(
    graph: TaskGraph,
    nodeId: string,
    patch: { objective?: string; acceptanceCriteria?: string },
): void {
    updateMutableNode(graph, nodeId, patch);
}

// ── Hierarchical helpers ─────────────────────────────────────────────────────

/**
 * Flatten a hierarchical graph into leaf nodes (nodes without a subGraph).
 * Each result includes the path through the hierarchy for identification.
 */
export function flattenLeafNodes(
    graph: TaskGraph,
    pathPrefix = '',
): Array<{ path: string; node: TaskNode }> {
    const result: Array<{ path: string; node: TaskNode }> = [];
    for (const node of graph.nodes) {
        const path = pathPrefix !== '' ? `${pathPrefix}/${node.id}` : node.id;
        if (node.subGraph !== undefined && node.subGraph.nodes.length > 0) {
            result.push(...flattenLeafNodes(node.subGraph, path));
        } else {
            result.push({ path, node });
        }
    }
    return result;
}

/**
 * Count total and completed leaf nodes across the entire hierarchy.
 * Used for progress tracking in the UI.
 */
export function countHierarchicalProgress(graph: TaskGraph): { total: number; done: number } {
    const leaves = flattenLeafNodes(graph);
    return {
        total: leaves.length,
        done: leaves.filter(({ node }) => node.status === 'done').length,
    };
}

/**
 * Derive graph status considering sub-graphs recursively.
 * A node with a subGraph derives its effective status from the sub-graph.
 */
export function deriveHierarchicalGraphStatus(graph: TaskGraph): TaskStatus {
    const statuses: TaskStatus[] = [];
    for (const node of graph.nodes) {
        if (node.subGraph !== undefined && node.subGraph.nodes.length > 0) {
            statuses.push(deriveHierarchicalGraphStatus(node.subGraph));
        } else {
            statuses.push(node.status);
        }
    }
    if (statuses.length === 0) return 'pending';
    if (statuses.some((s) => s === 'failed')) return 'failed';
    if (statuses.every((s) => s === 'done')) return 'done';
    if (statuses.some((s) => s === 'active' || s === 'blocked')) return 'active';
    if (statuses.some((s) => s === 'locked' || s === 'ready')) return 'active';
    return 'pending';
}
