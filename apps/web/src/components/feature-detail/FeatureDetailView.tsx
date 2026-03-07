'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { useEventStore } from '@/stores/eventStore';
import { useFeatureStore, type Feature } from '@/stores/featureStore';

import { FeatureStatusBadge } from '../shared/FeatureStatusBadge';
import { ProgressBar } from '../shared/ProgressBar';

import { ActivityTab } from './ActivityTab';
import { LogsTab } from './LogsTab';
import { OverviewTab } from './OverviewTab';
import { PreviewTab } from './PreviewTab';
import { StepsTab } from './StepsTab';
import { TabBar, type TabId } from './TabBar';
import { TerminalTab } from './TerminalTab';

interface FeatureDetailViewProps {
    featureId: string;
}

export function FeatureDetailView({ featureId }: FeatureDetailViewProps) {
    const feature = useFeatureStore((s) => s.features[featureId]);
    const allEvents = useEventStore((s) => s.events);
    const events = useMemo(
        () => allEvents.filter((e) => e.traceId === featureId),
        [allEvents, featureId],
    );

    // Determine available tabs
    const hasSandboxLogs = useMemo(
        () => events.some((e) => e.eventType === 'SANDBOX_LOG'),
        [events],
    );
    const tabs = useMemo(() => {
        const list: TabId[] = ['overview', 'steps', 'activity', 'terminal'];
        if (hasSandboxLogs) list.push('logs');
        if (feature?.previewUrl !== undefined && feature.previewUrl !== '') list.push('preview');
        return list;
    }, [feature?.previewUrl, hasSandboxLogs]);

    if (feature === undefined) {
        return (
            <div className="flex flex-col h-full items-center justify-center gap-4">
                <p className="text-muted-foreground">Feature not found</p>
                <Link
                    href="/features"
                    className="text-sm text-primary hover:text-primary/80"
                >
                    Back to features
                </Link>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <FeatureHeader feature={feature} />

            {/* Tab bar + content */}
            <TabBar tabs={tabs} featureId={featureId}>
                {(activeTab) => (
                    <div className={`flex-1 ${activeTab === 'terminal' || activeTab === 'preview' || activeTab === 'logs' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto p-6'}`}>
                        {activeTab === 'overview' && (
                            <OverviewTab feature={feature} events={events} />
                        )}
                        {activeTab === 'steps' && (
                            <StepsTab events={events} />
                        )}
                        {activeTab === 'activity' && (
                            <ActivityTab events={events} />
                        )}
                        {activeTab === 'terminal' && (
                            <TerminalTab events={events} />
                        )}
                        {activeTab === 'logs' && (
                            <LogsTab events={events} />
                        )}
                        {activeTab === 'preview' && feature.previewUrl !== undefined && feature.previewUrl !== '' && (
                            <PreviewTab url={feature.previewUrl} />
                        )}
                    </div>
                )}
            </TabBar>
        </div>
    );
}

function FeatureHeader({ feature }: { feature: Feature }) {
    return (
        <div className="shrink-0 px-6 py-4 border-b border-border/50 space-y-3">
            <div className="flex items-center gap-3">
                <Link
                    href="/features"
                    className="p-1 rounded-md hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="w-4 h-4" />
                </Link>
                <h1 className="text-lg font-semibold text-foreground flex-1 truncate">
                    {feature.title}
                </h1>
                <FeatureStatusBadge status={feature.status} />
            </div>

            {feature.stepsTotal > 0 && (
                <ProgressBar
                    current={feature.stepsComplete}
                    total={feature.stepsTotal}
                    className="max-w-md"
                />
            )}
        </div>
    );
}
