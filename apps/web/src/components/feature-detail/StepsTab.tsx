'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';

interface HierarchicalTaskNode {
    id: string;
    objective: string;
    status: string;
    acceptanceCriteria?: string;
    result?: string;
    error?: string;
    delegatable?: boolean;
    delegatedTo?: string;
    subGraph?: {
        nodes: HierarchicalTaskNode[];
        status: string;
    };
}

interface StepsTabProps {
    events: SystemEvent[];
}

export function StepsTab({ events }: StepsTabProps) {
    const steps = useMemo(() => {
        const graphEvents = events.filter((e) => e.eventType === 'TASK_GRAPH_UPDATED');

        // Prefer root graphs (isRootGraph === true) since they contain
        // the full hierarchy with nested sub-graphs. Fall back to the latest
        // event for backward compat with graphs emitted before this flag existed.
        const rootGraphEvents = graphEvents.filter(
            (e) => e.payload['isRootGraph'] === true,
        );
        const lastGraph = (rootGraphEvents.length > 0 ? rootGraphEvents : graphEvents).at(-1);
        if (lastGraph === undefined) return [];

        const graph = lastGraph.payload['graph'] as { nodes?: HierarchicalTaskNode[] } | undefined;
        return graph?.nodes ?? [];
    }, [events]);

    if (steps.length === 0) {
        return (
            <div className="flex items-center justify-center h-40">
                <p className="text-sm text-muted-foreground">No steps yet. The AI is planning...</p>
            </div>
        );
    }

    return (
        <div className="max-w-2xl space-y-1">
            {steps.map((step, index) => (
                <StepItem key={step.id} step={step} index={index} depth={0} />
            ))}
        </div>
    );
}

/** Count leaf nodes (nodes without sub-graphs) recursively */
function countSubProgress(nodes: HierarchicalTaskNode[]): { total: number; done: number } {
    let total = 0;
    let done = 0;
    for (const node of nodes) {
        if (node.subGraph !== undefined && node.subGraph.nodes.length > 0) {
            const sub = countSubProgress(node.subGraph.nodes);
            total += sub.total;
            done += sub.done;
        } else {
            total++;
            if (node.status === 'done') done++;
        }
    }
    return { total, done };
}

function StepItem({ step, index, depth }: { step: HierarchicalTaskNode; index: number; depth: number }) {
    const hasSubGraph = step.subGraph !== undefined && step.subGraph.nodes.length > 0;
    const [expanded, setExpanded] = useState(true);

    const statusConfig = {
        locked: {
            icon: Loader2,
            color: 'text-blue-400',
            label: 'Updating...',
            animate: true,
        },
        ready: {
            icon: Circle,
            color: 'text-blue-300',
            label: 'Ready',
        },
        pending: {
            icon: Circle,
            color: 'text-muted-foreground',
            label: 'Waiting',
        },
        active: {
            icon: Loader2,
            color: 'text-amber-400',
            label: 'Working on it',
            animate: true,
        },
        done: {
            icon: CheckCircle,
            color: 'text-emerald-400',
            label: 'Done',
        },
        failed: {
            icon: XCircle,
            color: 'text-red-400',
            label: 'Something went wrong',
        },
        skipped: {
            icon: Circle,
            color: 'text-muted-foreground/50',
            label: 'Skipped',
        },
    };

    const config = (statusConfig as Record<string, typeof statusConfig.pending>)[step.status] ?? statusConfig.pending;
    const Icon = config.icon;

    // Sub-progress for delegated nodes
    const subNodes = step.subGraph?.nodes;
    const subProgress = hasSubGraph && subNodes !== undefined ? countSubProgress(subNodes) : null;

    return (
        <div>
            <div
                className={`flex gap-3 p-3 rounded-lg ${step.status === 'active' ? 'bg-amber-500/5 border border-amber-500/20' : step.status === 'locked' ? 'bg-blue-500/5 border border-blue-500/20' : 'hover:bg-secondary/30'} transition-colors ${hasSubGraph ? 'cursor-pointer' : ''}`}
                onClick={hasSubGraph ? () => { setExpanded(!expanded); } : undefined}
            >
                {/* Expand/collapse chevron for delegated nodes */}
                {hasSubGraph ? (
                    <div className="pt-0.5 w-4 flex-shrink-0">
                        {expanded
                            ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    </div>
                ) : (
                    <div className="w-4 flex-shrink-0" />
                )}

                <div className="pt-0.5">
                    <Icon className={`w-5 h-5 ${config.color} ${'animate' in config && (config.animate as boolean) === true ? 'animate-spin' : ''}`} />
                </div>
                <div className="flex-1 space-y-1">
                    <div className="flex items-baseline gap-2">
                        <span className="text-xs text-muted-foreground font-mono">{index + 1}</span>
                        <p className="text-sm text-foreground">{step.objective}</p>
                    </div>
                    {/* Sub-progress indicator for delegated nodes */}
                    {subProgress !== null && (
                        <p className="text-xs text-muted-foreground">
                            {subProgress.done}/{subProgress.total} sub-tasks done
                        </p>
                    )}
                    {(step.status === 'active' || step.status === 'locked') && !hasSubGraph && (
                        <p className={`text-xs ${step.status === 'locked' ? 'text-blue-400' : 'text-amber-400'}`}>{config.label}</p>
                    )}
                    {step.error !== undefined && step.error !== '' && (
                        <p className="text-xs text-red-400">{step.error}</p>
                    )}
                    {step.result !== undefined && step.result !== '' && step.status === 'done' && !hasSubGraph && (
                        <p className="text-xs text-muted-foreground">{step.result}</p>
                    )}
                </div>
            </div>

            {/* Nested sub-graph */}
            {expanded && hasSubGraph && subNodes !== undefined && (
                <div className="ml-5 pl-3 border-l border-border/30 space-y-1 mt-1">
                    {subNodes.map((child, i) => (
                        <StepItem key={child.id} step={child} index={i} depth={depth + 1} />
                    ))}
                </div>
            )}
        </div>
    );
}
