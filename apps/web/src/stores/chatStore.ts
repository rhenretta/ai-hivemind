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
    type: 'text' | 'proposal' | 'progress' | 'clarification' | 'preview';
    proposal?: FeatureProposal;
    clarification?: ClarificationData;
    previewUrl?: string;
}

interface ChatState {
    messages: ChatMessage[];
    isAiTyping: boolean;

    appendMessage: (msg: ChatMessage) => void;
    updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
    setAiTyping: (typing: boolean) => void;
    loadHistory: (messages: ChatMessage[]) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
    messages: [],
    isAiTyping: false,

    appendMessage: (msg) =>
        set((state) => ({ messages: [...state.messages, msg] })),

    updateMessage: (id, patch) =>
        set((state) => ({
            messages: state.messages.map((m) =>
                m.id === id ? { ...m, ...patch } : m,
            ),
        })),

    setAiTyping: (isAiTyping) => set({ isAiTyping }),

    loadHistory: (messages) => set({ messages }),
}));

export const selectMessages = (s: ChatState) => s.messages;
export const selectIsAiTyping = (s: ChatState) => s.isAiTyping;
