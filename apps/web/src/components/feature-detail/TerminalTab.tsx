'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { ArrowDown, Clock, Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface TerminalTabProps {
    events: SystemEvent[];
}

type StreamKind = 'thought' | 'message' | 'tool' | 'result' | 'input' | 'error';

interface TerminalLine {
    id: string;
    timestamp: string;
    text: string;
    kind: StreamKind;
    direction: string;
}

const KIND_STYLES: Record<StreamKind, string> = {
    thought: 'text-slate-500 italic',
    message: 'text-slate-200',
    tool: 'text-teal-400',
    result: 'text-emerald-400',
    input: 'text-blue-400',
    error: 'text-red-400',
};

const KIND_PREFIX: Record<StreamKind, string> = {
    thought: '',
    message: '',
    tool: '$ ',
    result: '  ',
    input: '> ',
    error: '! ',
};

export function TerminalTab({ events }: TerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);
    const [showTimestamps, setShowTimestamps] = useState(false);
    const [showThoughts, setShowThoughts] = useState(true);

    const lines = useMemo(() => {
        const result: TerminalLine[] = [];
        for (const event of events) {
            if (event.eventType !== 'CONDUCTOR_STREAM') continue;
            const text = typeof event.payload['text'] === 'string' ? event.payload['text'] : '';
            const kind = (typeof event.payload['kind'] === 'string' ? event.payload['kind'] : 'message') as StreamKind;
            const direction = typeof event.payload['direction'] === 'string' ? event.payload['direction'] : 'out';
            if (text === '') continue;
            result.push({ id: event.eventId, timestamp: event.timestamp, text, kind, direction });
        }
        return result;
    }, [events]);

    const visibleLines = useMemo(() => {
        if (showThoughts) return lines;
        return lines.filter((l) => l.kind !== 'thought');
    }, [lines, showThoughts]);

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
                <button
                    onClick={() => setShowThoughts((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
                        showThoughts
                            ? 'bg-primary/20 text-primary'
                            : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                    }`}
                >
                    {showThoughts ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    Thinking
                </button>
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

            {/* Terminal output */}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto bg-[hsl(222,47%,3%)] font-mono text-xs leading-relaxed"
                style={{ contain: 'content' }}
            >
                {visibleLines.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-slate-600 text-sm">No terminal output yet</p>
                    </div>
                ) : (
                    <div className="p-3 space-y-px">
                        {visibleLines.map((line) => (
                            <div key={line.id} className="flex gap-2 min-h-[1.25rem]">
                                {showTimestamps && (
                                    <span className="shrink-0 text-slate-700 tabular-nums select-none w-[5.5rem]">
                                        {formatTime(line.timestamp)}
                                    </span>
                                )}
                                <span className={`${KIND_STYLES[line.kind]} whitespace-pre-wrap break-all`}>
                                    {KIND_PREFIX[line.kind]}{line.text}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
