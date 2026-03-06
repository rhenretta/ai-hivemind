import { FEATURE_STATUS_COLORS, FEATURE_STATUS_LABELS } from '@/lib/vocabulary';
import { type Feature, type FeatureStatus } from '@/stores/featureStore';

import { FeatureCard } from './FeatureCard';

interface KanbanColumnProps {
    status: FeatureStatus;
    features: Feature[];
}

export function KanbanColumn({ status, features }: KanbanColumnProps) {
    return (
        <div className="min-w-0 flex flex-col h-full">
            {/* Column header */}
            <div className="flex items-center gap-2 mb-3 px-1">
                <span className={`w-2 h-2 rounded-full ${FEATURE_STATUS_COLORS[status]}`} />
                <h2 className="text-sm font-medium text-foreground">
                    {FEATURE_STATUS_LABELS[status]}
                </h2>
                {features.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                        {features.length}
                    </span>
                )}
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {features.map((feature) => (
                    <FeatureCard key={feature.id} feature={feature} />
                ))}

                {features.length === 0 && (
                    <div className="flex items-center justify-center h-20 rounded-lg border border-dashed border-border/30">
                        <span className="text-xs text-muted-foreground/50">No features</span>
                    </div>
                )}
            </div>
        </div>
    );
}
