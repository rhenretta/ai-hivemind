'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { useFeatureStore } from '@/stores/featureStore';

import { FeatureStatusBadge } from '../shared/FeatureStatusBadge';
import { ProgressBar } from '../shared/ProgressBar';

interface FeatureProgressCardProps {
    traceId: string;
}

export function FeatureProgressCard({ traceId }: FeatureProgressCardProps) {
    const feature = useFeatureStore((s) => s.features[traceId]);

    if (feature === undefined) return null;

    return (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{feature.title}</span>
                <FeatureStatusBadge status={feature.status} />
            </div>

            {feature.stepsTotal > 0 && (
                <ProgressBar
                    current={feature.stepsComplete}
                    total={feature.stepsTotal}
                />
            )}

            {feature.currentStep !== undefined && feature.currentStep !== '' && (
                <p className="text-xs text-muted-foreground">
                    Working on: {feature.currentStep}
                </p>
            )}

            <Link
                href={`/features/${traceId}`}
                className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
            >
                View details
                <ArrowRight className="w-3 h-3" />
            </Link>
        </div>
    );
}
