'use client';

import { useSessionStore } from '@/stores/sessionStore';

import { ProgressBar } from '../shared/ProgressBar';

interface FeatureProgressCardProps {
    traceId: string;
}

export function FeatureProgressCard({ traceId }: FeatureProgressCardProps) {
    const session = useSessionStore((s) => s.sessions[traceId]);

    if (session === undefined) return null;

    return (
        <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{session.title}</span>
                <span className="text-xs text-muted-foreground capitalize">{session.status}</span>
            </div>

            {session.stepsTotal > 0 && (
                <ProgressBar
                    current={session.stepsComplete}
                    total={session.stepsTotal}
                />
            )}

            {session.currentStep !== undefined && session.currentStep !== '' && (
                <p className="text-xs text-muted-foreground">
                    Working on: {session.currentStep}
                </p>
            )}
        </div>
    );
}
