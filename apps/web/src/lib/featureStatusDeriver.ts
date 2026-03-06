import { type SystemEvent } from '@ai-hivemind/shared';

import { type FeatureStatus } from '@/stores/featureStore';

/**
 * Derives a feature's lifecycle status from its associated events.
 * Priority order: most specific state wins.
 */
export function deriveFeatureStatus(events: SystemEvent[]): FeatureStatus {
    // Check for unanswered input requests (blocked)
    const inputEvents = events.filter((e) => e.eventType === 'AGENT_INPUT_REQUIRED');
    const interventionEvents = events.filter((e) => e.eventType === 'USER_INTERVENTION');

    const hasUnansweredInput = inputEvents.some((inputEvent) =>
        !interventionEvents.some((intervention) =>
            intervention.timestamp > inputEvent.timestamp,
        ),
    );
    if (hasUnansweredInput) return 'blocked';

    // Check task graph for progress
    const graphEvents = events.filter((e) => e.eventType === 'TASK_GRAPH_UPDATED');
    const lastGraph = graphEvents.at(-1);

    if (lastGraph !== undefined) {
        const graph = lastGraph.payload['graph'] as { nodes?: { status: string }[] } | undefined;
        if (graph?.nodes !== undefined) {
            const allDone = graph.nodes.every((n) => n.status === 'done');
            const anyFailed = graph.nodes.some((n) => n.status === 'failed');

            if (allDone) return 'completed';
            if (anyFailed) return 'failed';

            // Check for active QA
            const hasActiveQA = events.some((e) =>
                e.eventType === 'QA_VERDICT' && e.payload['passed'] === false,
            );
            const lastQA = events.filter((e) => e.eventType === 'QA_VERDICT').at(-1);
            if (lastQA !== undefined && lastQA.payload['passed'] === false && !hasActiveQA) {
                return 'qa_in_progress';
            }

            return 'in_progress';
        }
    }

    // Check for proposal state
    const hasProposal = events.some((e) =>
        e.eventType === 'STATE_CHANGED' && e.payload['awaitingApproval'] === true,
    );
    if (hasProposal) {
        const hasApproval = events.some((e) =>
            e.eventType === 'USER_INTERVENTION' &&
            typeof e.payload['text'] === 'string' &&
            e.payload['text'].toUpperCase().includes('APPROVED'),
        );
        if (!hasApproval) return 'proposal';
    }

    // Check for completion
    const hasCompletion = events.some((e) =>
        e.eventType === 'STATE_CHANGED' && e.payload['taskComplete'] === true,
    );
    if (hasCompletion) return 'completed';

    return 'in_progress';
}

/**
 * Derive progress numbers from the latest task graph event.
 */
export function deriveProgress(events: SystemEvent[]): {
    stepsComplete: number;
    stepsTotal: number;
    currentStep?: string | undefined;
} {
    const graphEvents = events.filter((e) => e.eventType === 'TASK_GRAPH_UPDATED');
    const lastGraph = graphEvents.at(-1);

    if (lastGraph === undefined) {
        return { stepsComplete: 0, stepsTotal: 0 };
    }

    const graph = lastGraph.payload['graph'] as {
        nodes?: { status: string; objective?: string }[];
    } | undefined;

    if (graph?.nodes === undefined) {
        return { stepsComplete: 0, stepsTotal: 0 };
    }

    const stepsTotal = graph.nodes.length;
    const stepsComplete = graph.nodes.filter((n) => n.status === 'done').length;
    const activeNode = graph.nodes.find((n) => n.status === 'active');

    return {
        stepsComplete,
        stepsTotal,
        currentStep: typeof activeNode?.objective === 'string' ? activeNode.objective : undefined,
    };
}
