'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { AlertCircle, Check, ChevronDown, ChevronRight, Code2, Info, Loader2, MessageCircleQuestion } from 'lucide-react';
import { useCallback, useState } from 'react';

import { getActivityType, translateEvent } from '@/lib/eventTranslator';

import { JsonTreeRenderer } from '../inspector/JsonTreeRenderer';
import { RelativeTime } from '../shared/RelativeTime';

import { QaVerdictRenderer, StateChangedRenderer, TaskNodeRenderer, ToolUsedRenderer } from './activity-renderers';

const CUSTOM_RENDERER_TYPES = new Set([
    'STATE_CHANGED',
    'QA_VERDICT',
    'TASK_NODE_COMPLETED',
    'TOOL_USED',
    'ERROR',
]);

function hasCustomRenderer(eventType: string): boolean {
    return CUSTOM_RENDERER_TYPES.has(eventType);
}

interface ActivityItemProps {
    event: SystemEvent;
    nextEvent: SystemEvent | undefined;
}

export function ActivityItem({ event, nextEvent }: ActivityItemProps) {
    const summary = translateEvent(event);
    // 0 = collapsed, 1 = structured detail, 2 = raw JSON
    const [expandLevel, setExpandLevel] = useState<0 | 1 | 2>(0);
    const type = getActivityType(event);

    const toggleExpand = useCallback(() => {
        setExpandLevel((level) => {
            if (level === 0) return hasCustomRenderer(event.eventType) ? 1 : 2;
            return 0;
        });
    }, [event.eventType]);

    const typeConfig = {
        info: { icon: Info, color: 'text-muted-foreground' },
        progress: { icon: Loader2, color: 'text-blue-400' },
        success: { icon: Check, color: 'text-emerald-400' },
        error: { icon: AlertCircle, color: 'text-red-400' },
        question: { icon: MessageCircleQuestion, color: 'text-orange-400' },
    };

    const config = typeConfig[type];
    const Icon = config.icon;

    if (summary === null) return null;

    return (
        <div className="rounded-lg hover:bg-secondary/20 transition-colors">
            {/* Summary row */}
            <button
                onClick={toggleExpand}
                className="w-full flex items-start gap-3 p-2.5 text-left"
            >
                <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${config.color}`} />
                <span className="flex-1 text-sm text-foreground break-words whitespace-pre-wrap">{summary}</span>
                <RelativeTime
                    timestamp={event.timestamp}
                    className="text-[10px] text-muted-foreground shrink-0"
                />
                {expandLevel > 0 ? (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                )}
            </button>

            {/* Level 1: Structured detail */}
            {expandLevel >= 1 && hasCustomRenderer(event.eventType) && (
                <div className="px-2.5 pb-2 ml-7">
                    <div className="rounded-md bg-secondary/50 p-3 space-y-3">
                        {/* Event metadata */}
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                            <span className="font-mono">{event.eventType}</span>
                            <span className="font-mono">{event.eventId.slice(0, 8)}</span>
                            <span>from {event.sourceId}</span>
                        </div>

                        {/* Type-specific renderer */}
                        {event.eventType === 'STATE_CHANGED' && (
                            <StateChangedRenderer event={event} />
                        )}
                        {event.eventType === 'QA_VERDICT' && (
                            <QaVerdictRenderer event={event} />
                        )}
                        {event.eventType === 'TASK_NODE_COMPLETED' && (
                            <TaskNodeRenderer event={event} />
                        )}
                        {event.eventType === 'TOOL_USED' && (
                            <ToolUsedRenderer event={event} nextEvent={nextEvent} />
                        )}
                        {event.eventType === 'ERROR' && (
                            <ErrorDetailRenderer event={event} />
                        )}

                        {/* Toggle to raw JSON */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setExpandLevel(expandLevel === 2 ? 1 : 2);
                            }}
                            className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
                        >
                            <Code2 className="w-3 h-3" />
                            {expandLevel === 2 ? 'Hide raw JSON' : 'Show raw JSON'}
                        </button>
                    </div>
                </div>
            )}

            {/* Level 2: Raw JSON */}
            {expandLevel === 2 && (
                <div className="px-2.5 pb-2.5 ml-7">
                    <JsonTreeRenderer data={event.payload} />
                    {!hasCustomRenderer(event.eventType) && (
                        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span className="font-mono">{event.eventType}</span>
                            <span className="font-mono">{event.eventId.slice(0, 8)}</span>
                            <span>from {event.sourceId}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** Detailed error renderer — shows full error message, stack trace if available */
export function ErrorDetailRenderer({ event }: { event: SystemEvent }) {
    const message = typeof event.payload['message'] === 'string' ? event.payload['message'] : '';
    const stack = typeof event.payload['stack'] === 'string' ? event.payload['stack'] : '';
    const agentId = typeof event.payload['agentId'] === 'string' ? event.payload['agentId'] : '';

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
                <AlertCircle className="w-4 h-4 text-red-400" />
                <span className="text-sm font-medium text-red-300">Error</span>
                {agentId !== '' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 font-mono">
                        {agentId}
                    </span>
                )}
            </div>
            {message !== '' && (
                <div className="rounded-md bg-red-500/5 border border-red-500/20 p-2.5">
                    <p className="text-xs text-red-300 whitespace-pre-wrap break-words">{message}</p>
                </div>
            )}
            {stack !== '' && (
                <div className="rounded-md bg-black/20 border border-border/20 p-2 max-h-[300px] overflow-auto">
                    <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-words">
                        {stack}
                    </pre>
                </div>
            )}
        </div>
    );
}
