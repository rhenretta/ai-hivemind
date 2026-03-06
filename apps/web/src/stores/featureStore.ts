import { create } from 'zustand';

export type FeatureStatus =
    | 'proposal'
    | 'in_progress'
    | 'qa_in_progress'
    | 'blocked'
    | 'completed'
    | 'live'
    | 'failed';

export interface FeatureNeedsInput {
    eventId: string;
    question: string;
    timestamp: string;
}

export interface Feature {
    id: string;
    title: string;
    description: string;
    status: FeatureStatus;
    createdAt: string;
    updatedAt: string;
    stepsTotal: number;
    stepsComplete: number;
    currentStep?: string | undefined;
    previewUrl?: string | undefined;
    needsInput?: FeatureNeedsInput | undefined;
    route?: string | undefined;
}

export interface FeatureState {
    features: Record<string, Feature>;
    blockedCount: number;

    upsertFeature: (feature: Feature) => void;
    updateFeatureStatus: (id: string, status: FeatureStatus) => void;
    updateFeatureProgress: (
        id: string,
        stepsComplete: number,
        stepsTotal: number,
        currentStep?: string,
    ) => void;
    setFeaturePreview: (id: string, url: string) => void;
    setFeatureNeedsInput: (id: string, question: string, eventId: string) => void;
    clearFeatureNeedsInput: (id: string) => void;
    setFeatureDeployed: (id: string, route?: string) => void;
}

function countBlocked(features: Record<string, Feature>): number {
    let count = 0;
    for (const f of Object.values(features)) {
        if (f.status === 'blocked') count++;
    }
    return count;
}

export const useFeatureStore = create<FeatureState>()((set) => ({
    features: {},
    blockedCount: 0,

    upsertFeature: (feature) =>
        set((state) => {
            const features = { ...state.features, [feature.id]: feature };
            return { features, blockedCount: countBlocked(features) };
        }),

    updateFeatureStatus: (id, status) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: { ...existing, status, updatedAt: new Date().toISOString() },
            };
            return { features, blockedCount: countBlocked(features) };
        }),

    updateFeatureProgress: (id, stepsComplete, stepsTotal, currentStep) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: { ...existing, stepsComplete, stepsTotal, currentStep, updatedAt: new Date().toISOString() },
            };
            return { features };
        }),

    setFeaturePreview: (id, url) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: { ...existing, previewUrl: url, updatedAt: new Date().toISOString() },
            };
            return { features };
        }),

    setFeatureNeedsInput: (id, question, eventId) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: {
                    ...existing,
                    status: 'blocked' as const,
                    needsInput: { eventId, question, timestamp: new Date().toISOString() },
                    updatedAt: new Date().toISOString(),
                },
            };
            return { features, blockedCount: countBlocked(features) };
        }),

    clearFeatureNeedsInput: (id) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: {
                    ...existing,
                    needsInput: undefined,
                    status: existing.status === 'blocked' ? ('in_progress' as const) : existing.status,
                    updatedAt: new Date().toISOString(),
                },
            };
            return { features, blockedCount: countBlocked(features) };
        }),

    setFeatureDeployed: (id, route) =>
        set((state) => {
            const existing = state.features[id];
            if (existing === undefined) return state;
            const features = {
                ...state.features,
                [id]: {
                    ...existing,
                    status: 'live' as const,
                    route,
                    updatedAt: new Date().toISOString(),
                },
            };
            return { features, blockedCount: countBlocked(features) };
        }),
}));

export const selectBlockedCount = (s: FeatureState): number => s.blockedCount;

export const selectLiveFeatures = (s: FeatureState): Feature[] =>
    Object.values(s.features).filter((f) => f.status === 'live' && f.route !== undefined);
