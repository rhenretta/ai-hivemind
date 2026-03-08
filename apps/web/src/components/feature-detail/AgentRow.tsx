'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import {
    Bot,
    CheckCircle,
    ChevronDown,
    ChevronRight,
    Code,
    Eye,
    Loader2,
    Palette,
    Search,
    ShieldCheck,
    XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { type AgentNode, isDefaultExpanded } from '@/lib/agentTree';
import { translateEvent } from '@/lib/eventTranslator';

import { ActivityItem } from './ActivityItem';

// ── Role styling ─────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<string, { icon: typeof Bot; color: string; bg: string }> = {
    'project-manager': { icon: Bot, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    'data-researcher': { icon: Search, color: 'text-purple-400', bg: 'bg-purple-500/10' },
    'site-explorer': { icon: Eye, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
    'ux-designer': { icon: Palette, color: 'text-violet-400', bg: 'bg-violet-500/10' },
    'swe-agent': { icon: Code, color: 'text-green-400', bg: 'bg-green-500/10' },
    'qa-engineer': { icon: ShieldCheck, color: 'text-lime-400', bg: 'bg-lime-500/10' },
};

const DEFAULT_CONFIG = { icon: Bot, color: 'text-muted-foreground', bg: 'bg-secondary/50' };

// ── Duration formatter ───────────────────────────────────────────────────────

function formatDuration(firstTs: string, lastTs: string): string {
    if (firstTs === '' || lastTs === '') return '';
    const ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const remainder = Math.round(s % 60);
    return `${m}m ${remainder}s`;
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'running' | 'completed' | 'failed' }) {
    if (status === 'running') {
        return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />;
    }
    if (status === 'completed') {
        return <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    }
    // status === 'failed'
    return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
}

// ── Component ────────────────────────────────────────────────────────────────

interface AgentRowProps {
    node: AgentNode;
    depth?: number;
}

export function AgentRow({ node, depth = 0 }: AgentRowProps) {
    const [expanded, setExpanded] = useState(isDefaultExpanded(node.role));
    const config = ROLE_CONFIG[node.role] ?? DEFAULT_CONFIG;
    const Icon = config.icon;

    const duration = formatDuration(node.stats.firstTimestamp, node.stats.lastTimestamp);

    // Filter to visible events (those that have a translation)
    const visibleEvents = useMemo(() => {
        const items: { event: SystemEvent; nextEvent: SystemEvent | undefined }[] = [];
        // Get all events for this agent, filter to those that translate
        for (let i = 0; i < node.events.length; i++) {
            const event = node.events[i];
            if (event === undefined) continue;
            const summary = translateEvent(event);
            if (summary !== null) {
                items.push({ event, nextEvent: node.events[i + 1] });
            }
        }
        return items;
    }, [node.events]);

    // Build a unified chronological list of own events + child agent rows
    // so everything renders in real time order, not "PM events first, then children".
    type TimelineItem =
        | { kind: 'event'; event: SystemEvent; nextEvent: SystemEvent | undefined; ts: string }
        | { kind: 'agent'; child: AgentNode; ts: string };

    const timeline = useMemo(() => {
        const items: TimelineItem[] = [];
        for (const ve of visibleEvents) {
            items.push({ kind: 'event', event: ve.event, nextEvent: ve.nextEvent, ts: ve.event.timestamp });
        }
        for (const child of node.children) {
            items.push({ kind: 'agent', child, ts: child.stats.firstTimestamp });
        }
        items.sort((a, b) => a.ts.localeCompare(b.ts));
        return items;
    }, [visibleEvents, node.children]);

    const visibleCount = visibleEvents.length;
    const hasContent = visibleCount > 0 || node.children.length > 0;

    return (
        <div style={{ marginLeft: depth > 0 ? `${depth * 16}px` : undefined }}>
            {/* Agent header row */}
            <button
                onClick={() => { if (hasContent) setExpanded(!expanded); }}
                className={`
                    w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors text-left
                    ${hasContent ? 'hover:bg-secondary/30 cursor-pointer' : 'cursor-default'}
                    ${expanded ? 'bg-secondary/20' : ''}
                `}
            >
                {/* Expand chevron */}
                {hasContent ? (
                    expanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )
                ) : (
                    <span className="w-3.5 shrink-0" />
                )}

                {/* Role icon */}
                <span className={`p-1 rounded ${config.bg}`}>
                    <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                </span>

                {/* Agent name */}
                <span className="text-sm font-medium text-foreground">
                    {node.displayName}
                </span>

                {/* Agent ID suffix (muted) */}
                <span className="text-[10px] font-mono text-muted-foreground hidden sm:inline">
                    {node.agentId}
                </span>

                {/* Spacer */}
                <span className="flex-1" />

                {/* Status */}
                <StatusDot status={node.stats.status} />

                {/* Duration */}
                {duration !== '' && (
                    <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                        {duration}
                    </span>
                )}

                {/* Stats pills */}
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary/60 text-muted-foreground tabular-nums">
                    {visibleCount} event{visibleCount !== 1 ? 's' : ''}
                </span>
                {node.stats.toolCalls > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary/60 text-muted-foreground tabular-nums">
                        {node.stats.toolCalls} tool{node.stats.toolCalls !== 1 ? 's' : ''}
                    </span>
                )}
            </button>

            {/* Expanded content — chronological mix of own events + child agents */}
            {expanded && (
                <div className="ml-3.5 border-l border-border/30 pl-3 pb-1">
                    <div className="space-y-0.5">
                        {timeline.map((item) =>
                            item.kind === 'event' ? (
                                <ActivityItem
                                    key={item.event.eventId}
                                    event={item.event}
                                    nextEvent={item.nextEvent}
                                />
                            ) : (
                                <AgentRow key={item.child.agentId} node={item.child} depth={0} />
                            ),
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
