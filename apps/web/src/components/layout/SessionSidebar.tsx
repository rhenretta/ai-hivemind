'use client';

import {
    MessageSquare,
    Plus,
    Settings,
    Sparkles,
    Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { getSocket } from '@/hooks/useSocket';
import {
    useSessionStore,
    selectSessions,
    type SessionEntry,
} from '@/stores/sessionStore';

import { ConnectionIndicator } from './ConnectionIndicator';

// ── Status display helpers ───────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
    exploring: 'bg-blue-400',
    planning: 'bg-indigo-400',
    active: 'bg-amber-400 animate-pulse',
    blocked: 'bg-orange-500',
    completed: 'bg-emerald-400',
    failed: 'bg-red-500',
};

const STATUS_GROUP_ORDER = ['active', 'blocked', 'exploring', 'planning', 'completed', 'failed'] as const;

const STATUS_GROUP_LABEL: Record<string, string> = {
    active: 'Building',
    blocked: 'Needs Input',
    exploring: 'Exploring',
    planning: 'Planning',
    completed: 'Completed',
    failed: 'Failed',
};

// ── Component ────────────────────────────────────────────────────────────────

export function SessionSidebar() {
    const pathname = usePathname();
    const sessionsMap = useSessionStore(selectSessions);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const setActiveSession = useSessionStore((s) => s.setActiveSession);

    // Derive sorted list + group from stable sessions record
    const sessions = useMemo(
        () => Object.values(sessionsMap).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        [sessionsMap],
    );

    const grouped = useMemo(() => {
        const groups = new Map<string, SessionEntry[]>();
        for (const session of sessions) {
            const list = groups.get(session.status) ?? [];
            list.push(session);
            groups.set(session.status, list);
        }
        return groups;
    }, [sessions]);

    const handleNewSession = useCallback(() => {
        setActiveSession(null);
    }, [setActiveSession]);

    const handleSelectSession = useCallback(
        (id: string) => {
            setActiveSession(id);
        },
        [setActiveSession],
    );

    const handleDeleteSession = useCallback(
        (e: React.MouseEvent, id: string) => {
            e.stopPropagation();
            const ws = getSocket();
            ws.emit('user:delete-session', { traceId: id });
        },
        [],
    );

    return (
        <nav className="w-60 shrink-0 flex flex-col border-r border-border/50 bg-card">
            {/* Logo + title */}
            <div className="shrink-0 flex items-center gap-2.5 px-4 py-4 border-b border-border/50">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    <Sparkles className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm font-semibold text-foreground">AI Hivemind</span>
            </div>

            {/* New session button */}
            <div className="shrink-0 px-3 py-3">
                <button
                    onClick={handleNewSession}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg
                        border border-dashed border-border/50 text-muted-foreground
                        hover:text-foreground hover:bg-secondary/50 hover:border-border transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    New Session
                </button>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
                {sessions.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                        <MessageSquare className="w-8 h-8 text-muted-foreground/30 mb-3" />
                        <p className="text-xs text-muted-foreground/60">
                            No sessions yet.
                            <br />
                            Start a conversation!
                        </p>
                    </div>
                )}

                {STATUS_GROUP_ORDER.map((status) => {
                    const group = grouped.get(status);
                    if (group === undefined || group.length === 0) return null;

                    return (
                        <div key={status}>
                            <div className="flex items-center gap-1.5 px-2 py-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] ?? 'bg-gray-400'}`} />
                                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                                    {STATUS_GROUP_LABEL[status] ?? status}
                                </span>
                                <span className="text-[10px] text-muted-foreground/40">
                                    {group.length}
                                </span>
                            </div>

                            {group.map((session) => (
                                <SessionRow
                                    key={session.id}
                                    session={session}
                                    isActive={session.id === activeSessionId}
                                    onSelect={handleSelectSession}
                                    onDelete={handleDeleteSession}
                                />
                            ))}
                        </div>
                    );
                })}
            </div>

            {/* Bottom: settings + connection */}
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-t border-border/50">
                <Link
                    href="/settings"
                    className={`
                        flex items-center gap-2 text-sm transition-colors
                        ${pathname === '/settings'
                            ? 'text-primary'
                            : 'text-muted-foreground hover:text-foreground'
                        }
                    `}
                >
                    <Settings className="w-4 h-4" />
                    Settings
                </Link>
                <ConnectionIndicator />
            </div>
        </nav>
    );
}

// ── Session row ──────────────────────────────────────────────────────────────

function SessionRow({
    session,
    isActive,
    onSelect,
    onDelete,
}: {
    session: SessionEntry;
    isActive: boolean;
    onSelect: (id: string) => void;
    onDelete: (e: React.MouseEvent, id: string) => void;
}) {
    const hasProgress = session.stepsTotal > 0;
    const progressPct = hasProgress
        ? Math.round((session.stepsComplete / session.stepsTotal) * 100)
        : 0;

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onSelect(session.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(session.id); } }}
            className={`
                group w-full text-left px-2.5 py-2 rounded-lg transition-colors cursor-pointer
                ${isActive
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                }
            `}
        >
            <div className="flex items-start justify-between gap-1">
                <span className="text-sm leading-snug line-clamp-2 flex-1">
                    {session.title}
                </span>
                <button
                    onClick={(e) => onDelete(e, session.id)}
                    className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100
                        text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10
                        transition-all"
                    title="Delete session"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>

            {/* Progress bar */}
            {hasProgress && (
                <div className="mt-1.5 h-1 rounded-full bg-secondary overflow-hidden">
                    <div
                        className="h-full rounded-full bg-primary/60 transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                    />
                </div>
            )}
        </div>
    );
}
