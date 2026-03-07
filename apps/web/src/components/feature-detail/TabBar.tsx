'use client';

import { type ReactNode, useState } from 'react';

export type TabId = 'overview' | 'steps' | 'activity' | 'terminal' | 'logs' | 'preview';

const TAB_LABELS: Record<TabId, string> = {
    overview: 'Overview',
    steps: 'Steps',
    activity: 'Activity',
    terminal: 'Terminal',
    logs: 'Server Logs',
    preview: 'Preview',
};

interface TabBarProps {
    tabs: TabId[];
    featureId: string;
    children: (activeTab: TabId) => ReactNode;
}

export function TabBar({ tabs, children }: TabBarProps) {
    const [activeTab, setActiveTab] = useState<TabId>(tabs[0] ?? 'overview');

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Tab buttons */}
            <div className="shrink-0 flex gap-0 border-b border-border/50 px-6">
                {tabs.map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`
                            px-4 py-2.5 text-sm font-medium transition-colors
                            border-b-2 -mb-px
                            ${activeTab === tab
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
            {children(activeTab)}
        </div>
    );
}
