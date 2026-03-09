'use client';

import { useMemo, useState } from 'react';

import { ChatInput } from '@/components/chat/ChatInput';
import { MessageList } from '@/components/chat/MessageList';
import { ActivityTab } from '@/components/feature-detail/ActivityTab';
import { DetailsTab } from '@/components/feature-detail/DetailsTab';
import { LogsTab } from '@/components/feature-detail/LogsTab';
import { MemoryTab } from '@/components/feature-detail/MemoryTab';
import { PreviewTab } from '@/components/feature-detail/PreviewTab';
import { StepsTab } from '@/components/feature-detail/StepsTab';
import { TerminalTab } from '@/components/feature-detail/TerminalTab';
import { useChatStore, selectSessionMessages, selectIsAiTyping } from '@/stores/chatStore';
import { useEventStore } from '@/stores/eventStore';
import {
    useSessionStore,
    selectActiveSession,
    type SessionEntry,
} from '@/stores/sessionStore';

// ── Tab definitions ──────────────────────────────────────────────────────────

type TabId = 'chat' | 'details' | 'steps' | 'activity' | 'memory' | 'terminal' | 'logs' | 'preview';

const TAB_LABELS: Record<TabId, string> = {
    chat: 'Chat',
    details: 'Details',
    steps: 'Steps',
    activity: 'Activity',
    memory: 'Memory',
    terminal: 'Terminal',
    logs: 'Server Logs',
    preview: 'Preview',
};

// ── SessionView ─────────────────────────────────────────────────────────────

export function SessionView() {
    const activeSession = useSessionStore(selectActiveSession);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);

    // When no session is selected, show the new session prompt
    if (activeSessionId === null || activeSession === undefined) {
        return <NewSessionPrompt />;
    }

    return <SessionTabs sessionId={activeSessionId} session={activeSession} />;
}

// ── New session prompt ──────────────────────────────────────────────────────

function NewSessionPrompt() {
    return (
        <div className="flex flex-col h-full">
            {/* Chat-style message area with empty state */}
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md px-6">
                    <h2 className="text-xl font-semibold text-foreground mb-2">
                        What would you like to build?
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        Tell me about something you&apos;d like to build &mdash; I&apos;ll help you
                        think it through and start building as we go.
                    </p>
                </div>
            </div>

            {/* Input — sending a message creates a new session */}
            <ChatInput />
        </div>
    );
}

// ── Session tabs ─────────────────────────────────────────────────────────────

function SessionTabs({
    sessionId,
    session,
}: {
    sessionId: string;
    session: SessionEntry;
}) {
    const [activeTab, setActiveTab] = useState<TabId>('chat');

    // Get session-scoped data
    const messagesSelector = useMemo(() => selectSessionMessages(sessionId), [sessionId]);
    const messages = useChatStore(messagesSelector);
    const isAiTyping = useChatStore(selectIsAiTyping);

    const allEvents = useEventStore((s) => s.events);
    const events = useMemo(
        () => allEvents.filter((e) => e.traceId === sessionId),
        [allEvents, sessionId],
    );

    // Determine available tabs dynamically
    const hasSandboxLogs = useMemo(
        () => events.some((e) => e.eventType === 'SANDBOX_LOG'),
        [events],
    );
    const hasConductorStream = useMemo(
        () => events.some((e) => e.eventType === 'CONDUCTOR_STREAM'),
        [events],
    );
    const hasTaskGraph = useMemo(
        () => events.some((e) => e.eventType === 'TASK_GRAPH_UPDATED'),
        [events],
    );
    const hasMemory = useMemo(
        () => events.some((e) => e.eventType === 'MEMORY_STORED'),
        [events],
    );

    const tabs = useMemo(() => {
        const list: TabId[] = ['chat', 'details'];
        if (hasTaskGraph) list.push('steps');
        if (events.length > 0) list.push('activity');
        if (hasMemory) list.push('memory');
        if (hasConductorStream) list.push('terminal');
        if (hasSandboxLogs) list.push('logs');
        if (session.previewUrl !== undefined && session.previewUrl !== '') list.push('preview');
        return list;
    }, [hasTaskGraph, events.length, hasConductorStream, hasSandboxLogs, hasMemory, session.previewUrl]);

    // If active tab no longer available, fall back to chat
    const resolvedTab = tabs.includes(activeTab) ? activeTab : 'chat';

    return (
        <div className="flex flex-col h-full">
            {/* Tab bar */}
            <div className="shrink-0 flex items-center gap-0 border-b border-border/50 px-6">
                {tabs.map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`
                            px-4 py-2.5 text-sm font-medium transition-colors
                            border-b-2 -mb-px
                            ${resolvedTab === tab
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }
                        `}
                    >
                        {TAB_LABELS[tab]}
                    </button>
                ))}
            </div>

            {/* Tab content */}
            <div className={`flex-1 ${
                resolvedTab === 'terminal' || resolvedTab === 'preview' || resolvedTab === 'logs'
                    ? 'overflow-hidden flex flex-col'
                    : resolvedTab === 'chat'
                        ? 'flex flex-col overflow-hidden'
                        : 'overflow-y-auto p-6'
            }`}>
                {resolvedTab === 'chat' && (
                    <>
                        <MessageList messages={messages} isAiTyping={isAiTyping} />
                        <ChatInput />
                    </>
                )}
                {resolvedTab === 'details' && (
                    <DetailsTab sessionId={sessionId} session={session} events={events} />
                )}
                {resolvedTab === 'steps' && (
                    <StepsTab events={events} />
                )}
                {resolvedTab === 'activity' && (
                    <ActivityTab events={events} />
                )}
                {resolvedTab === 'memory' && (
                    <MemoryTab sessionId={sessionId} events={events} />
                )}
                {resolvedTab === 'terminal' && (
                    <TerminalTab events={events} />
                )}
                {resolvedTab === 'logs' && (
                    <LogsTab events={events} />
                )}
                {resolvedTab === 'preview' && session.previewUrl !== undefined && session.previewUrl !== '' && (
                    <PreviewTab url={session.previewUrl} />
                )}
            </div>
        </div>
    );
}
