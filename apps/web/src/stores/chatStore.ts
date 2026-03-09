import { create } from 'zustand';

export interface FeatureProposal {
    title: string;
    description: string;
    steps: string[];
    status: 'proposed' | 'approved' | 'rejected';
}

export interface ClarificationData {
    question: string;
    responded: boolean;
    response?: string;
}

export interface ContextSource {
    tool: string;
    summary: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'ai';
    text: string;
    timestamp: string;
    traceId?: string;
    type: 'text' | 'proposal' | 'progress' | 'clarification' | 'preview' | 'dialogue';
    proposal?: FeatureProposal;
    clarification?: ClarificationData;
    previewUrl?: string;
    /** Context sources gathered by the context agent for this dialogue response */
    contextSources?: ContextSource[];
}

interface ChatState {
    /** Messages keyed by sessionId (traceId). */
    messagesBySession: Record<string, ChatMessage[]>;
    isAiTyping: boolean;

    appendMessage: (msg: ChatMessage) => void;
    updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
    setAiTyping: (typing: boolean) => void;
    loadHistory: (messages: ChatMessage[]) => void;
    clearSessionMessages: (sessionId: string) => void;
    clearAllMessages: () => void;
}

export const useChatStore = create<ChatState>()((set) => ({
    messagesBySession: {},
    isAiTyping: false,

    appendMessage: (msg) =>
        set((state) => {
            const sessionId = msg.traceId ?? '__global__';
            const existing = state.messagesBySession[sessionId] ?? [];

            // Deduplicate: skip if a message with the same id already exists
            if (existing.some((m) => m.id === msg.id)) return state;

            return {
                messagesBySession: {
                    ...state.messagesBySession,
                    [sessionId]: [...existing, msg],
                },
            };
        }),

    updateMessage: (id, patch) =>
        set((state) => {
            const updated: Record<string, ChatMessage[]> = {};
            let changed = false;

            for (const [sessionId, messages] of Object.entries(state.messagesBySession)) {
                const idx = messages.findIndex((m) => m.id === id);
                if (idx >= 0) {
                    const newMessages = [...messages];
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- idx from findIndex >= 0
                    const oldMsg = newMessages[idx]!;
                    const newMsg = { ...oldMsg, ...patch };
                    newMessages[idx] = newMsg;

                    // If traceId changed (intent:resolved linking), move message to correct session
                    const newSessionId = newMsg.traceId ?? '__global__';
                    if (newSessionId !== sessionId) {
                        // Remove from current session
                        updated[sessionId] = newMessages.filter((_, i) => i !== idx);
                        // Add to target session
                        const target = state.messagesBySession[newSessionId] ?? [];
                        updated[newSessionId] = [...target, newMsg];
                    } else {
                        updated[sessionId] = newMessages;
                    }
                    changed = true;
                } else {
                    updated[sessionId] = messages;
                }
            }

            return changed ? { messagesBySession: updated } : state;
        }),

    setAiTyping: (isAiTyping) => set({ isAiTyping }),

    loadHistory: (messages) => {
        // Reconstruct per-session map from flat list
        const bySession: Record<string, ChatMessage[]> = {};
        for (const msg of messages) {
            const sessionId = msg.traceId ?? '__global__';
            if (bySession[sessionId] === undefined) bySession[sessionId] = [];
            bySession[sessionId].push(msg);
        }
        return set({ messagesBySession: bySession });
    },

    clearSessionMessages: (sessionId) =>
        set((state) => {
            const { [sessionId]: _, ...remaining } = state.messagesBySession;
            return { messagesBySession: remaining };
        }),

    clearAllMessages: () =>
        set({ messagesBySession: {}, isAiTyping: false }),
}));

// ── Selectors ────────────────────────────────────────────────────────────────

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Get messages for a specific session.
 * Returns a stable empty array when no messages exist (SSR-safe).
 */
export function selectSessionMessages(sessionId: string | null) {
    return (s: ChatState): ChatMessage[] => {
        if (sessionId === null) return EMPTY_MESSAGES;
        return s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
    };
}

export const selectIsAiTyping = (s: ChatState) => s.isAiTyping;
