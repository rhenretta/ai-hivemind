'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { AlertCircle, Check, Clock, Eye, Loader2, Play, Rocket, Send } from 'lucide-react';
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';

import { getSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';
import { type Feature, useFeatureStore } from '@/stores/featureStore';

import { RelativeTime } from '../shared/RelativeTime';

import { ArtifactsSection } from './ArtifactsSection';

interface OverviewTabProps {
    feature: Feature;
    events: SystemEvent[];
}

export function OverviewTab({ feature, events }: OverviewTabProps) {
    const [response, setResponse] = useState('');
    const [deploying, setDeploying] = useState(false);
    const appendMessage = useChatStore((s) => s.appendMessage);
    const clearFeatureNeedsInput = useFeatureStore((s) => s.clearFeatureNeedsInput);

    const handleDeploy = useCallback(() => {
        setDeploying(true);
        const ws = getSocket();
        ws.emit('user:checkout', { traceId: feature.id });
    }, [feature.id]);

    const handleRespond = useCallback(() => {
        if (response.trim() === '') return;

        appendMessage({
            id: uuid(),
            role: 'user',
            text: response.trim(),
            timestamp: new Date().toISOString(),
            traceId: feature.id,
            type: 'text',
        });
        clearFeatureNeedsInput(feature.id);

        const ws = getSocket();
        ws.emit('user:intervention', {
            text: response.trim(),
            targetId: 'conductor',
            traceId: feature.id,
        });
        setResponse('');
    }, [response, feature.id, appendMessage, clearFeatureNeedsInput]);

    // Derive milestones from events
    const milestones = deriveMilestones(events);

    return (
        <div className="max-w-2xl space-y-6">
            {/* Deploy prompt */}
            {feature.status === 'completed' && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <Rocket className="w-5 h-5 text-emerald-400" />
                        <span className="font-medium text-emerald-300">Ready to deploy</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        This feature passed all quality checks. Deploy it to make it live on the site.
                    </p>
                    <button
                        onClick={handleDeploy}
                        disabled={deploying}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors text-sm font-medium"
                    >
                        {deploying ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Deploying...
                            </>
                        ) : (
                            <>
                                <Rocket className="w-4 h-4" />
                                Deploy Feature
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Needs Input (prominent) */}
            {feature.needsInput !== undefined && (
                <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-5 space-y-3">
                    <div className="flex items-center gap-2">
                        <AlertCircle className="w-5 h-5 text-orange-400" />
                        <span className="font-medium text-orange-300">Needs your input</span>
                    </div>
                    <p className="text-sm text-foreground">{feature.needsInput.question}</p>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={response}
                            onChange={(e) => setResponse(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleRespond()}
                            placeholder="Type your answer..."
                            className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                        />
                        <button
                            onClick={handleRespond}
                            disabled={response.trim() === ''}
                            className="px-4 py-2 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Status summary */}
            <div className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">Status</h2>
                <div className="rounded-lg border border-border/50 bg-card p-4 space-y-1">
                    {feature.currentStep !== undefined && feature.currentStep !== '' && (
                        <p className="text-sm text-foreground">
                            Currently working on: <span className="text-primary">{feature.currentStep}</span>
                        </p>
                    )}
                    {feature.stepsTotal > 0 && (
                        <p className="text-sm text-muted-foreground">
                            {feature.stepsComplete} of {feature.stepsTotal} steps completed
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                        Started <RelativeTime timestamp={feature.createdAt} className="inline" />
                    </p>
                </div>
            </div>

            {/* Artifacts */}
            <ArtifactsSection events={events} />

            {/* Timeline */}
            {milestones.length > 0 && (
                <div className="space-y-2">
                    <h2 className="text-sm font-medium text-muted-foreground">Timeline</h2>
                    <div className="space-y-0">
                        {milestones.map((m, i) => (
                            <div key={i} className="flex gap-3 py-2">
                                <div className="flex flex-col items-center">
                                    <div className={`w-6 h-6 rounded-full flex items-center justify-center ${m.color}`}>
                                        <m.icon className="w-3 h-3" />
                                    </div>
                                    {i < milestones.length - 1 && (
                                        <div className="w-px flex-1 bg-border/50 mt-1" />
                                    )}
                                </div>
                                <div className="pb-3">
                                    <p className="text-sm text-foreground">{m.label}</p>
                                    <RelativeTime
                                        timestamp={m.timestamp}
                                        className="text-xs text-muted-foreground"
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

interface Milestone {
    label: string;
    timestamp: string;
    icon: typeof Check;
    color: string;
}

function deriveMilestones(events: SystemEvent[]): Milestone[] {
    const milestones: Milestone[] = [];

    const userCommand = events.find((e) => e.eventType === 'USER_COMMAND');
    if (userCommand !== undefined) {
        milestones.push({
            label: 'Feature requested',
            timestamp: userCommand.timestamp,
            icon: Clock,
            color: 'bg-blue-500/20 text-blue-400',
        });
    }

    const graphCreated = events.find((e) => e.eventType === 'TASK_GRAPH_UPDATED');
    if (graphCreated !== undefined) {
        milestones.push({
            label: 'Started building',
            timestamp: graphCreated.timestamp,
            icon: Play,
            color: 'bg-amber-500/20 text-amber-400',
        });
    }

    const qaPassed = events.filter((e) =>
        e.eventType === 'QA_VERDICT' && e.payload['passed'] === true,
    );
    const lastQa = qaPassed[qaPassed.length - 1];
    if (lastQa !== undefined) {
        milestones.push({
            label: 'Quality check passed',
            timestamp: lastQa.timestamp,
            icon: Check,
            color: 'bg-emerald-500/20 text-emerald-400',
        });
    }

    const deployed = events.find((e) => e.eventType === 'SERVICE_DEPLOYED');
    if (deployed !== undefined) {
        milestones.push({
            label: 'Preview ready',
            timestamp: deployed.timestamp,
            icon: Eye,
            color: 'bg-emerald-500/20 text-emerald-400',
        });
    }

    const completed = events.find((e) =>
        e.eventType === 'STATE_CHANGED' && e.payload['taskComplete'] === true,
    );
    if (completed !== undefined) {
        milestones.push({
            label: 'Completed',
            timestamp: completed.timestamp,
            icon: Check,
            color: 'bg-emerald-500/20 text-emerald-400',
        });
    }

    const featureDeployed = events.find((e) => e.eventType === 'FEATURE_DEPLOYED');
    if (featureDeployed !== undefined) {
        milestones.push({
            label: 'Deployed to site',
            timestamp: featureDeployed.timestamp,
            icon: Rocket,
            color: 'bg-emerald-500/20 text-emerald-400',
        });
    }

    return milestones;
}
