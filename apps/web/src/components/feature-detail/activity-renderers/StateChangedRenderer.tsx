'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, Clock, DollarSign, Palette } from 'lucide-react';
import { useState } from 'react';

import { QaTestPlanRenderer } from './QaTestPlanRenderer';

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
    const designSpec = payload['designSpec'] as Record<string, string> | undefined;
    const testPlan = payload['testPlan'] as { tests: { id: string; name: string; description?: string; type: string; status: string; result?: string }[] } | undefined;

    if (taskComplete) {
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">Task completed</span>
                </div>
                {message !== '' && (
                    <p className="text-xs text-foreground/70 pl-6 whitespace-pre-wrap break-words">{message}</p>
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

    const screenshotB64 = typeof payload['screenshotB64'] === 'string' ? payload['screenshotB64'] : '';

    return (
        <div className="space-y-2">
            {state !== '' && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono">
                    {state}
                </span>
            )}
            {message !== '' && (
                <p className="text-xs text-foreground/70 whitespace-pre-wrap break-words">{message}</p>
            )}
            {screenshotB64 !== '' && (
                <div className="rounded-md bg-black/20 border border-border/20 p-1 max-h-[500px] overflow-auto">
                    <img
                        src={screenshotB64}
                        alt="QA screenshot"
                        className="w-full rounded"
                    />
                </div>
            )}
            {designSpec !== undefined && <DesignSpecDetail spec={designSpec} />}
            {testPlan !== undefined && <QaTestPlanRenderer plan={testPlan} />}
        </div>
    );
}

/** Renders the UX design spec fields in a structured expandable format */
function DesignSpecDetail({ spec }: { spec: Record<string, string> }) {
    const [expanded, setExpanded] = useState(false);
    const fields = [
        { key: 'layout', label: 'Layout' },
        { key: 'componentHierarchy', label: 'Components' },
        { key: 'userFlow', label: 'User Flow' },
        { key: 'styling', label: 'Styling' },
        { key: 'wireframe', label: 'Wireframe' },
        { key: 'uxAcceptanceCriteria', label: 'Acceptance Criteria' },
    ];

    const hasContent = fields.some((f) => typeof spec[f.key] === 'string' && spec[f.key] !== '');
    if (!hasContent) return null;

    return (
        <div className="space-y-2">
            <button
                onClick={() => setExpanded(!expanded)}
                className="inline-flex items-center gap-1.5 text-[11px] text-violet-400 hover:text-violet-300 transition-colors"
            >
                <Palette className="w-3.5 h-3.5" />
                {expanded ? 'Hide design spec' : 'Show design spec'}
            </button>
            {expanded && (
                <div className="space-y-3 pl-1">
                    {fields.map((f) => {
                        const val = typeof spec[f.key] === 'string' ? spec[f.key] : '';
                        if (val === '') return null;
                        return (
                            <div key={f.key} className="space-y-1">
                                <span className="text-[10px] font-medium text-violet-300/70 uppercase tracking-wider">
                                    {f.label}
                                </span>
                                <div className="rounded-md bg-black/20 border border-border/20 p-2.5 max-h-[300px] overflow-auto">
                                    <pre className="text-[11px] text-foreground/70 font-mono whitespace-pre-wrap break-words">
                                        {val}
                                    </pre>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
