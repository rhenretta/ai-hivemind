'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, Circle, Loader2, XCircle } from 'lucide-react';
import { useMemo } from 'react';

interface TaskNode {
    id: string;
    objective: string;
    status: string;
    acceptanceCriteria?: string;
    result?: string;
    error?: string;
}

interface StepsTabProps {
    events: SystemEvent[];
}

export function StepsTab({ events }: StepsTabProps) {
    const steps = useMemo(() => {
        const graphEvents = events.filter((e) => e.eventType === 'TASK_GRAPH_UPDATED');
        const lastGraph = graphEvents.at(-1);
        if (lastGraph === undefined) return [];

        const graph = lastGraph.payload['graph'] as { nodes?: TaskNode[] } | undefined;
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
                <StepItem key={step.id} step={step} index={index} />
            ))}
        </div>
    );
}

function StepItem({ step, index }: { step: TaskNode; index: number }) {
    const statusConfig = {
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

    return (
        <div className={`flex gap-3 p-3 rounded-lg ${step.status === 'active' ? 'bg-amber-500/5 border border-amber-500/20' : 'hover:bg-secondary/30'} transition-colors`}>
            <div className="pt-0.5">
                <Icon className={`w-5 h-5 ${config.color} ${'animate' in config && (config.animate as boolean) === true ? 'animate-spin' : ''}`} />
            </div>
            <div className="flex-1 space-y-1">
                <div className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground font-mono">{index + 1}</span>
                    <p className="text-sm text-foreground">{step.objective}</p>
                </div>
                {step.status === 'active' && (
                    <p className="text-xs text-amber-400">{config.label}</p>
                )}
                {step.error !== undefined && step.error !== '' && (
                    <p className="text-xs text-red-400">{step.error}</p>
                )}
                {step.result !== undefined && step.result !== '' && step.status === 'done' && (
                    <p className="text-xs text-muted-foreground">{step.result}</p>
                )}
            </div>
        </div>
    );
}
