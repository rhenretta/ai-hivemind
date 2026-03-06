import { create } from 'zustand';

export type FeatureDetailTab = 'overview' | 'steps' | 'activity' | 'terminal' | 'preview';

interface FeatureDetailState {
    activeFeatureId: string | null;
    activeTab: FeatureDetailTab;
    expandedActivityId: string | null;

    setActiveFeature: (id: string | null) => void;
    setActiveTab: (tab: FeatureDetailTab) => void;
    setExpandedActivity: (id: string | null) => void;
}

export const useFeatureDetailStore = create<FeatureDetailState>()((set) => ({
    activeFeatureId: null,
    activeTab: 'overview',
    expandedActivityId: null,

    setActiveFeature: (activeFeatureId) =>
        set({ activeFeatureId, activeTab: 'overview', expandedActivityId: null }),

    setActiveTab: (activeTab) => set({ activeTab }),

    setExpandedActivity: (expandedActivityId) => set({ expandedActivityId }),
}));
