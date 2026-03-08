import { type SystemEventType } from '@ai-hivemind/shared';

import { type FeatureStatus } from '@/stores/featureStore';

/** Human-readable column names for the kanban board */
export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
    proposal: 'Thinking About It',
    in_progress: 'Building',
    qa_in_progress: 'Checking Quality',
    blocked: 'Needs Your Input',
    completed: 'Ready to Check Out',
    live: 'Live',
    failed: 'Something Went Wrong',
};

/** Status dot colors for feature cards */
export const FEATURE_STATUS_COLORS: Record<FeatureStatus, string> = {
    proposal: 'bg-blue-400',
    in_progress: 'bg-amber-400',
    qa_in_progress: 'bg-purple-400',
    blocked: 'bg-orange-500',
    completed: 'bg-emerald-400',
    live: 'bg-emerald-500',
    failed: 'bg-red-500',
};

/** Event types that are visible in the simplified Activity tab */
const VISIBLE_EVENT_TYPES = new Set<SystemEventType>([
    'USER_COMMAND',
    'USER_INTERVENTION',
    'TOOL_USED',
    'TASK_PLAN_CREATED',
    'QA_VERDICT',
    'SERVICE_DEPLOYED',
    'AGENT_INPUT_REQUIRED',
    'TASK_GRAPH_UPDATED',
    'TASK_NODE_COMPLETED',
    'ERROR',
    'STATE_CHANGED',
    'FEATURE_DEPLOYED',
    'DIALOGUE_RESPONSE',
    'DIALOGUE_UPDATE_PLAN',
]);

export function isVisibleEvent(eventType: SystemEventType): boolean {
    return VISIBLE_EVENT_TYPES.has(eventType);
}

/** Kanban column order for display */
export const KANBAN_COLUMNS: FeatureStatus[] = [
    'proposal',
    'in_progress',
    'qa_in_progress',
    'blocked',
    'failed',
    'completed',
    'live',
];
