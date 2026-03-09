import { type Session, type SessionStatus } from '@ai-hivemind/shared';
import { create } from 'zustand';

// ── Extended session with frontend-only transient data ──────────────────────

export interface SessionEntry extends Session {
    /** Step progress tracked from TASK_GRAPH_UPDATED events */
    stepsTotal: number;
    stepsComplete: number;
    currentStep?: string | undefined;
    /** Preview URL from SERVICE_DEPLOYED */
    previewUrl?: string | undefined;
    /** Blocked question from AGENT_INPUT_REQUIRED */
    needsInput?: { eventId: string; question: string; timestamp: string } | undefined;
}

interface SessionState {
    sessions: Record<string, SessionEntry>;
    activeSessionId: string | null;

    // Hydration
    hydrateSessions: (sessions: Session[]) => void;

    // CRUD
    upsertSession: (session: Session) => void;
    updateSessionStatus: (id: string, status: SessionStatus) => void;
    updateSessionProgress: (id: string, stepsComplete: number, stepsTotal: number, currentStep?: string) => void;
    setSessionPreview: (id: string, url: string) => void;
    setSessionNeedsInput: (id: string, question: string, eventId: string) => void;
    clearSessionNeedsInput: (id: string) => void;
    deleteSession: (id: string) => void;

    // Navigation
    setActiveSession: (id: string | null) => void;
}

function toEntry(session: Session): SessionEntry {
    return { ...session, stepsTotal: 0, stepsComplete: 0 };
}

export const useSessionStore = create<SessionState>()((set) => ({
    sessions: {},
    activeSessionId: null,

    hydrateSessions: (sessions) =>
        set((state) => {
            const map: Record<string, SessionEntry> = {};
            for (const s of sessions) {
                // Preserve transient data if session already exists locally
                const existing = state.sessions[s.id];
                map[s.id] = existing !== undefined
                    ? { ...existing, ...s }
                    : toEntry(s);
            }
            return { sessions: map };
        }),

    upsertSession: (session) =>
        set((state) => {
            const existing = state.sessions[session.id];
            const entry = existing !== undefined
                ? { ...existing, ...session }
                : toEntry(session);
            return { sessions: { ...state.sessions, [session.id]: entry } };
        }),

    updateSessionStatus: (id, status) =>
        set((state) => {
            const existing = state.sessions[id];
            if (existing === undefined) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [id]: { ...existing, status, updatedAt: new Date().toISOString() },
                },
            };
        }),

    updateSessionProgress: (id, stepsComplete, stepsTotal, currentStep) =>
        set((state) => {
            const existing = state.sessions[id];
            if (existing === undefined) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [id]: { ...existing, stepsComplete, stepsTotal, currentStep, updatedAt: new Date().toISOString() },
                },
            };
        }),

    setSessionPreview: (id, url) =>
        set((state) => {
            const existing = state.sessions[id];
            if (existing === undefined) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [id]: { ...existing, previewUrl: url, updatedAt: new Date().toISOString() },
                },
            };
        }),

    setSessionNeedsInput: (id, question, eventId) =>
        set((state) => {
            const existing = state.sessions[id];
            if (existing === undefined) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [id]: {
                        ...existing,
                        status: 'blocked' as SessionStatus,
                        needsInput: { eventId, question, timestamp: new Date().toISOString() },
                        updatedAt: new Date().toISOString(),
                    },
                },
            };
        }),

    clearSessionNeedsInput: (id) =>
        set((state) => {
            const existing = state.sessions[id];
            if (existing === undefined) return state;
            return {
                sessions: {
                    ...state.sessions,
                    [id]: {
                        ...existing,
                        needsInput: undefined,
                        status: existing.status === 'blocked' ? 'active' : existing.status,
                        updatedAt: new Date().toISOString(),
                    },
                },
            };
        }),

    deleteSession: (id) =>
        set((state) => {
            const { [id]: _, ...remaining } = state.sessions;
            const activeSessionId = state.activeSessionId === id ? null : state.activeSessionId;
            return { sessions: remaining, activeSessionId };
        }),

    setActiveSession: (activeSessionId) => set({ activeSessionId }),
}));

// ── Selectors ────────────────────────────────────────────────────────────────

export const selectActiveSession = (s: SessionState): SessionEntry | undefined => {
    if (s.activeSessionId === null) return undefined;
    return s.sessions[s.activeSessionId];
};

/** Subscribe to the raw sessions record — derive lists in useMemo. */
export const selectSessions = (s: SessionState): Record<string, SessionEntry> => s.sessions;

export const selectBlockedCount = (s: SessionState): number =>
    Object.values(s.sessions).filter((s) => s.status === 'blocked').length;
