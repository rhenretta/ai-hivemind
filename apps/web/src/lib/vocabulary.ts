import { type SystemEventType } from '@ai-hivemind/shared';

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
    'QA_ARBITER_DECISION',
]);

export function isVisibleEvent(eventType: SystemEventType): boolean {
    return VISIBLE_EVENT_TYPES.has(eventType);
}
