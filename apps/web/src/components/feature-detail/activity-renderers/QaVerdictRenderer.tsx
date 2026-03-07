'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, XCircle } from 'lucide-react';

import { QaTestPlanRenderer } from './QaTestPlanRenderer';

interface QaVerdictRendererProps {
    event: SystemEvent;
}

export function QaVerdictRenderer({ event }: QaVerdictRendererProps) {
    const passed = event.payload['passed'] === true;
    const subtask = typeof event.payload['subtask'] === 'string' ? event.payload['subtask'] : '';
    const issues = Array.isArray(event.payload['issues']) ? (event.payload['issues'] as string[]) : [];
    const summary = typeof event.payload['summary'] === 'string' ? event.payload['summary'] : '';
    const stepsToReproduce = Array.isArray(event.payload['stepsToReproduce']) ? (event.payload['stepsToReproduce'] as string[]) : [];
    const testPlan = event.payload['testPlan'] as { tests: { id: string; name: string; description?: string; type: string; status: string; result?: string }[] } | undefined;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                {passed ? (
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                )}
                <span className={`text-sm font-medium ${passed ? 'text-emerald-300' : 'text-red-300'}`}>
                    {passed ? 'Quality check passed' : 'Quality check failed'}
                </span>
            </div>

            {subtask !== '' && (
                <p className="text-xs text-muted-foreground pl-6 whitespace-pre-wrap break-words">
                    Subtask: {subtask}
                </p>
            )}

            {!passed && issues.length > 0 && (
                <ul className="pl-6 space-y-1.5">
                    {issues.map((issue, i) => (
                        <li key={i} className="text-xs text-red-300/80 flex items-start gap-1.5">
                            <span className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-red-400" />
                            <span className="whitespace-pre-wrap break-words">
                                {typeof issue === 'string' ? issue : JSON.stringify(issue)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {!passed && stepsToReproduce.length > 0 && (
                <div className="pl-6 space-y-1">
                    <p className="text-[11px] font-medium text-orange-300/80">Steps to reproduce:</p>
                    <ol className="space-y-0.5 pl-1">
                        {stepsToReproduce.map((step, i) => (
                            <li key={i} className="text-[11px] text-foreground/50 font-mono whitespace-pre-wrap break-words">
                                {step}
                            </li>
                        ))}
                    </ol>
                </div>
            )}

            {summary !== '' && (
                <p className="text-xs text-foreground/60 pl-6 whitespace-pre-wrap break-words">
                    {summary}
                </p>
            )}

            {testPlan !== undefined && <div className="pl-6"><QaTestPlanRenderer plan={testPlan} /></div>}
        </div>
    );
}
