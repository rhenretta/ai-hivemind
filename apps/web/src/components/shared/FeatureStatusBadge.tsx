import { FEATURE_STATUS_COLORS, FEATURE_STATUS_LABELS } from '@/lib/vocabulary';
import { type FeatureStatus } from '@/stores/featureStore';

interface FeatureStatusBadgeProps {
    status: FeatureStatus;
    className?: string;
}

export function FeatureStatusBadge({ status, className = '' }: FeatureStatusBadgeProps) {
    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}>
            <span className={`w-2 h-2 rounded-full ${FEATURE_STATUS_COLORS[status]} ${status === 'blocked' ? 'animate-pulse' : ''}`} />
            {FEATURE_STATUS_LABELS[status]}
        </span>
    );
}
