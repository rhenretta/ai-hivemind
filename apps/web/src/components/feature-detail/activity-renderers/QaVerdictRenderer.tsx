'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, XCircle } from 'lucide-react';

interface QaVerdictRendererProps {
    event: SystemEvent;
}

export function QaVerdictRenderer({ event }: QaVerdictRendererProps) {
    const passed = event.payload['passed'] === true;
    const subtask = typeof event.payload['subtask'] === 'string' ? event.payload['subtask'] : '';
    const issues = Array.isArray(event.payload['issues']) ? (event.payload['issues'] as string[]) : [];

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
                <p className="text-xs text-muted-foreground pl-6">
                    Subtask: {subtask}
                </p>
            )}

            {!passed && issues.length > 0 && (
                <ul className="pl-6 space-y-1">
                    {issues.map((issue, i) => (
                        <li key={i} className="text-xs text-red-300/80 flex items-start gap-1.5">
                            <span className="text-red-500 mt-1.5 shrink-0 w-1 h-1 rounded-full bg-red-400" />
                            {typeof issue === 'string' ? issue : JSON.stringify(issue)}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
