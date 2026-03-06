'use client';

import { useMemo } from 'react';

import { KANBAN_COLUMNS } from '@/lib/vocabulary';
import { useFeatureStore, type Feature, type FeatureStatus } from '@/stores/featureStore';

import { KanbanColumn } from './KanbanColumn';

export function FeatureBoard() {
    const features = useFeatureStore((s) => s.features);

    const featuresByStatus = useMemo(() => {
        const grouped: Record<FeatureStatus, Feature[]> = {
            proposal: [],
            in_progress: [],
            qa_in_progress: [],
            blocked: [],
            completed: [],
            live: [],
            failed: [],
        };
        for (const feature of Object.values(features)) {
            grouped[feature.status].push(feature);
        }
        return grouped;
    }, [features]);

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/50">
                <h1 className="text-lg font-semibold text-foreground">Features</h1>
            </div>

            {/* Board */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden">
                <div className="grid grid-cols-6 gap-4 p-6 h-full min-w-[900px]">
                    {KANBAN_COLUMNS.map((status) => (
                        <KanbanColumn
                            key={status}
                            status={status}
                            features={featuresByStatus[status]}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
