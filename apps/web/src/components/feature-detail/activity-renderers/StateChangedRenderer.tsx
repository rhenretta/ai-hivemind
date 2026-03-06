'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, Clock, DollarSign } from 'lucide-react';

interface StateChangedRendererProps {
    event: SystemEvent;
}

export function StateChangedRenderer({ event }: StateChangedRendererProps) {
    const payload = event.payload;
    const message = typeof payload['message'] === 'string' ? payload['message'] : '';
    const taskComplete = payload['taskComplete'] === true;
    const awaitingApproval = payload['awaitingApproval'] === true;
    const costUsd = typeof payload['cost_usd'] === 'number' ? payload['cost_usd'] : undefined;
    const numTurns = typeof payload['num_turns'] === 'number' ? payload['num_turns'] : undefined;
    const durationMs = typeof payload['duration_ms'] === 'number' ? payload['duration_ms'] : undefined;
    const state = typeof payload['state'] === 'string' ? payload['state'] : '';

    if (taskComplete) {
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">Task completed</span>
                </div>
                {message !== '' && (
                    <p className="text-xs text-foreground/70 pl-6">{message}</p>
                )}
                {(costUsd !== undefined || numTurns !== undefined || durationMs !== undefined) && (
                    <div className="flex items-center gap-4 pl-6 text-[10px] text-muted-foreground">
                        {costUsd !== undefined && (
                            <span className="flex items-center gap-1">
                                <DollarSign className="w-3 h-3" />
                                ${costUsd.toFixed(4)}
                            </span>
                        )}
                        {numTurns !== undefined && (
                            <span>{numTurns} turns</span>
                        )}
                        {durationMs !== undefined && (
                            <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {(durationMs / 1000).toFixed(1)}s
                            </span>
                        )}
                    </div>
                )}
            </div>
        );
    }

    if (awaitingApproval) {
        const proposal = payload['proposal'] as Record<string, unknown> | undefined;
        const title = typeof proposal?.['title'] === 'string' ? proposal['title'] : '';
        return (
            <div className="space-y-1">
                <span className="text-xs text-amber-400">Awaiting approval</span>
                {title !== '' && (
                    <p className="text-xs text-foreground/70">Proposal: {title}</p>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-1">
            {state !== '' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono">
                    {state}
                </span>
            )}
            {message !== '' && (
                <p className="text-xs text-foreground/70">{message}</p>
            )}
        </div>
    );
}
