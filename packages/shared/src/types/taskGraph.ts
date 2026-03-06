import { z } from 'zod';

/**
 * taskGraph.ts — Task Graph types for the TaskOrchestrator engine.
 *
 * A TaskGraph is a DAG of TaskNodes. The orchestrator:
 *   1. Decomposes an objective into nodes (with LLM help)
 *   2. Processes nodes sequentially, respecting dependsOn edges
 *   3. Each leaf node (isAtomic=true) is executed via Conductor plugin
 *   4. Composite nodes are further decomposed by a child orchestrator
 *
 * State is kept in-memory and mirrored to the event bus as TASK_GRAPH_UPDATED events.
 */

export const TaskStatusSchema = z.enum([
    'pending',   // waiting for dependencies to complete
    'active',    // currently being executed
    'done',      // completed successfully
    'failed',    // failed after all retries exhausted
    'skipped',   // skipped because a dependency failed
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

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
     * true  → leaf task: send to Conductor via /conductor:newTrack + /conductor:implement
     * false → composite: decompose further with a child TaskOrchestrator
     */
    isAtomic: z.boolean(),

    /** Human-readable result summary, set on completion */
    result: z.string().optional(),

    /** Error message, set on failure */
    error: z.string().optional(),

    /** Number of QA retry attempts used */
    attempts: z.number().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskGraphSchema = z.object({
    /** The top-level user objective that spawned this graph */
    rootObjective: z.string(),

    /** Ordered list of nodes; execution respects dependsOn edges */
    nodes: z.array(TaskNodeSchema),

    /** ISO timestamp of when this graph was created */
    createdAt: z.string(),

    /** Overall graph status — derived from node statuses */
    status: TaskStatusSchema,
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

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
    if (statuses.some((s) => s === 'active')) return 'active';
    return 'pending';
}
