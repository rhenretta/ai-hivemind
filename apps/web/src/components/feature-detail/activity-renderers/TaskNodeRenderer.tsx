'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { CheckCircle, Circle, XCircle } from 'lucide-react';

interface TaskNodeRendererProps {
    event: SystemEvent;
}

export function TaskNodeRenderer({ event }: TaskNodeRendererProps) {
    const nodeId = typeof event.payload['nodeId'] === 'string' ? event.payload['nodeId'] : '';
    const status = typeof event.payload['status'] === 'string' ? event.payload['status'] : '';
    const result = typeof event.payload['result'] === 'string' ? event.payload['result'] : '';
    const error = typeof event.payload['error'] === 'string' ? event.payload['error'] : '';

    const StatusIcon = status === 'done' ? CheckCircle : status === 'failed' ? XCircle : Circle;
    const statusColor = status === 'done' ? 'text-emerald-400' : status === 'failed' ? 'text-red-400' : 'text-muted-foreground';
    const statusLabel = status === 'done' ? 'Completed' : status === 'failed' ? 'Failed' : status;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <StatusIcon className={`w-4 h-4 ${statusColor}`} />
                <span className="text-xs font-mono text-muted-foreground">{nodeId}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    status === 'done'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : status === 'failed'
                            ? 'bg-red-500/10 text-red-400'
                            : 'bg-secondary text-muted-foreground'
                }`}>
                    {statusLabel}
                </span>
            </div>

            {result !== '' && (
                <div className="pl-6">
                    <p className="text-xs text-foreground/70 whitespace-pre-wrap break-words">{result}</p>
                </div>
            )}

            {error !== '' && (
                <div className="pl-6 rounded-md bg-red-500/5 border border-red-500/20 p-2">
                    <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{error}</p>
                </div>
            )}
        </div>
    );
}
