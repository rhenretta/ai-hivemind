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
}

const CHAT_CLEARED_AT_KEY = 'ai-hivemind:chatClearedAt';

interface ChatState {
    messages: ChatMessage[];
    isAiTyping: boolean;
    /** ISO timestamp — events before this are hidden after a clear */
    chatClearedAt: string | null;

    appendMessage: (msg: ChatMessage) => void;
    updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
    setAiTyping: (typing: boolean) => void;
    loadHistory: (messages: ChatMessage[]) => void;
    clearMessages: () => void;
}

function loadClearedAt(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(CHAT_CLEARED_AT_KEY);
}

export const useChatStore = create<ChatState>()((set) => ({
    messages: [],
    isAiTyping: false,
    chatClearedAt: loadClearedAt(),

    appendMessage: (msg) =>
        set((state) => {
            // Deduplicate: skip if a message with the same id already exists
            if (state.messages.some((m) => m.id === msg.id)) return state;
            // Skip messages from before the chat was cleared
            if (state.chatClearedAt !== null && msg.timestamp <= state.chatClearedAt) return state;
            return { messages: [...state.messages, msg] };
        }),

    updateMessage: (id, patch) =>
        set((state) => ({
            messages: state.messages.map((m) =>
                m.id === id ? { ...m, ...patch } : m,
            ),
        })),

    setAiTyping: (isAiTyping) => set({ isAiTyping }),

    loadHistory: (messages) => set({ messages }),

    clearMessages: () => {
        const clearedAt = new Date().toISOString();
        if (typeof window !== 'undefined') {
            localStorage.setItem(CHAT_CLEARED_AT_KEY, clearedAt);
        }
        return set({ messages: [], isAiTyping: false, chatClearedAt: clearedAt });
    },
}));

export const selectMessages = (s: ChatState) => s.messages;
export const selectIsAiTyping = (s: ChatState) => s.isAiTyping;
