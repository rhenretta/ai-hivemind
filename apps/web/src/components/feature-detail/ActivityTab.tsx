'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { AlertCircle, Check, ChevronDown, ChevronRight, Code2, Info, Loader2, MessageCircleQuestion } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { getActivityType, translateEvent } from '@/lib/eventTranslator';

import { JsonTreeRenderer } from '../inspector/JsonTreeRenderer';
import { RelativeTime } from '../shared/RelativeTime';

import { QaVerdictRenderer, StateChangedRenderer, TaskNodeRenderer, ToolUsedRenderer } from './activity-renderers';

interface ActivityTabProps {
    events: SystemEvent[];
}

export function ActivityTab({ events }: ActivityTabProps) {
    const activities = useMemo(() => {
        const items: { event: SystemEvent; summary: string; nextEvent?: SystemEvent | undefined }[] = [];
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event === undefined) continue;
            const summary = translateEvent(event);
            if (summary !== null) {
                const nextEvent = i + 1 < events.length ? events[i + 1] : undefined;
                items.push({ event, summary, nextEvent });
            }
        }
        return items;
    }, [events]);

    if (activities.length === 0) {
        return (
            <div className="flex items-center justify-center h-40">
                <p className="text-sm text-muted-foreground">No activity yet</p>
            </div>
        );
    }

    return (
        <div className="max-w-3xl space-y-0.5">
            {activities.map(({ event, summary, nextEvent }) => (
                <ActivityItem key={event.eventId} event={event} summary={summary} nextEvent={nextEvent} />
            ))}
        </div>
    );
}

function hasCustomRenderer(eventType: string): boolean {
    return eventType === 'TOOL_USED'
        || eventType === 'STATE_CHANGED'
        || eventType === 'QA_VERDICT'
        || eventType === 'TASK_NODE_COMPLETED';
}

function ActivityItem({
    event,
    summary,
    nextEvent,
}: {
    event: SystemEvent;
    summary: string;
    nextEvent?: SystemEvent | undefined;
}) {
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

    return (
        <div className="rounded-lg hover:bg-secondary/20 transition-colors">
            {/* Summary row */}
            <button
                onClick={toggleExpand}
                className="w-full flex items-center gap-3 p-2.5 text-left"
            >
                <Icon className={`w-4 h-4 shrink-0 ${config.color}`} />
                <span className="flex-1 text-sm text-foreground truncate">{summary}</span>
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
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span className="font-mono">{event.eventType}</span>
                            <span className="font-mono">{event.eventId.slice(0, 8)}</span>
                            <span>from {event.sourceId}</span>
                        </div>

                        {/* Type-specific renderer */}
                        {event.eventType === 'TOOL_USED' && (
                            <ToolUsedRenderer event={event} nextEvent={nextEvent} />
                        )}
                        {event.eventType === 'STATE_CHANGED' && (
                            <StateChangedRenderer event={event} />
                        )}
                        {event.eventType === 'QA_VERDICT' && (
                            <QaVerdictRenderer event={event} />
                        )}
                        {event.eventType === 'TASK_NODE_COMPLETED' && (
                            <TaskNodeRenderer event={event} />
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
