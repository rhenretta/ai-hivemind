'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { ArrowDown, Clock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LogsTabProps {
    events: SystemEvent[];
}

type LogSource = 'stdout' | 'stderr' | 'backend' | 'frontend';

interface LogLine {
    id: string;
    timestamp: string;
    text: string;
    source: LogSource;
}

const SOURCE_STYLES: Record<LogSource, string> = {
    stdout: 'text-slate-300',
    stderr: 'text-amber-400',
    backend: 'text-teal-400',
    frontend: 'text-violet-400',
};

const SOURCE_LABELS: Record<LogSource, string> = {
    stdout: 'out',
    stderr: 'err',
    backend: 'be',
    frontend: 'fe',
};

export function LogsTab({ events }: LogsTabProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);
    const [showTimestamps, setShowTimestamps] = useState(false);
    const [sourceFilter, setSourceFilter] = useState<LogSource | 'all'>('all');

    const lines = useMemo(() => {
        const result: LogLine[] = [];
        for (const event of events) {
            if (event.eventType !== 'SANDBOX_LOG') continue;
            const text = typeof event.payload['text'] === 'string' ? event.payload['text'] : '';
            const source = (typeof event.payload['source'] === 'string' ? event.payload['source'] : 'stdout') as LogSource;
            if (text === '') continue;
            result.push({ id: event.eventId, timestamp: event.timestamp, text, source });
        }
        return result;
    }, [events]);

    const visibleLines = useMemo(() => {
        if (sourceFilter === 'all') return lines;
        return lines.filter((l) => l.source === sourceFilter);
    }, [lines, sourceFilter]);

    const scrollToBottom = useCallback(() => {
        const el = containerRef.current;
        if (el !== null) {
            el.scrollTop = el.scrollHeight;
        }
    }, []);

    useEffect(() => {
        if (!isUserScrolledUp.current) {
            scrollToBottom();
        }
    }, [visibleLines.length, scrollToBottom]);

    const handleScroll = useCallback(() => {
        const el = containerRef.current;
        if (el === null) return;
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        isUserScrolledUp.current = distFromBottom > 40;
    }, []);

    const formatTime = useCallback((ts: string) => {
        try {
            const d = new Date(ts);
            return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch {
            return '';
        }
    }, []);

    const sources: (LogSource | 'all')[] = ['all', 'backend', 'frontend', 'stderr', 'stdout'];

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border/30 bg-secondary/20">
                <button
                    onClick={() => setShowTimestamps((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
                        showTimestamps
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                    }`}
                >
                    <Clock className="w-3 h-3" />
                    Timestamps
                </button>
                <div className="h-4 w-px bg-border/30" />
                {sources.map((s) => (
                    <button
                        key={s}
                        onClick={() => setSourceFilter(s)}
                        className={`px-2 py-1 text-xs rounded-md transition-colors ${
                            sourceFilter === s
                                ? 'bg-primary/20 text-primary'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                        }`}
                    >
                        {s === 'all' ? 'All' : s}
                    </button>
                ))}
                <div className="flex-1" />
                {isUserScrolledUp.current && (
                    <button
                        onClick={() => {
                            isUserScrolledUp.current = false;
                            scrollToBottom();
                        }}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                    >
                        <ArrowDown className="w-3 h-3" />
                        Scroll to bottom
                    </button>
                )}
                <span className="text-[10px] text-muted-foreground tabular-nums">
                    {visibleLines.length} lines
                </span>
            </div>

            {/* Log output */}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto bg-[hsl(222,47%,3%)] font-mono text-xs leading-relaxed"
                style={{ contain: 'content' }}
            >
                {visibleLines.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-slate-600 text-sm">No server logs yet</p>
                    </div>
                ) : (
                    <div className="p-3 space-y-px">
                        {visibleLines.map((line, idx) => (
                            <div key={`${line.id}-${idx.toString()}`} className="flex gap-2 min-h-[1.25rem]">
                                {showTimestamps && (
                                    <span className="shrink-0 text-slate-700 tabular-nums select-none w-[5.5rem]">
                                        {formatTime(line.timestamp)}
                                    </span>
                                )}
                                <span className="shrink-0 text-[10px] w-[1.5rem] text-slate-600 select-none text-right">
                                    {SOURCE_LABELS[line.source]}
                                </span>
                                <span className={`${SOURCE_STYLES[line.source]} whitespace-pre-wrap break-all`}>
                                    {line.text}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
