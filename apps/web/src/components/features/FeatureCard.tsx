'use client';

import { Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';

import { getSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';
import { type Feature, useFeatureStore } from '@/stores/featureStore';

import { FeatureStatusBadge } from '../shared/FeatureStatusBadge';
import { ProgressBar } from '../shared/ProgressBar';
import { RelativeTime } from '../shared/RelativeTime';

interface FeatureCardProps {
    feature: Feature;
}

export function FeatureCard({ feature }: FeatureCardProps) {
    const [response, setResponse] = useState('');
    const appendMessage = useChatStore((s) => s.appendMessage);
    const clearFeatureNeedsInput = useFeatureStore((s) => s.clearFeatureNeedsInput);

    const handleDelete = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const ws = getSocket();
        ws.emit('user:delete-feature', { traceId: feature.id });
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
        useChatStore.getState().setAiTyping(true);

        const ws = getSocket();
        ws.emit('user:intervention', {
            text: response.trim(),
            targetId: 'conductor',
            traceId: feature.id,
        });

        setResponse('');
    }, [response, feature.id, appendMessage, clearFeatureNeedsInput]);

    const isBlocked = feature.status === 'blocked';

    return (
        <div className={`rounded-lg border ${isBlocked ? 'border-orange-500/40 bg-orange-500/5' : 'border-border/50 bg-card'} p-3 space-y-2.5 transition-colors hover:border-border`}>
            <Link href={`/features/${feature.id}`} className="block space-y-2.5">
                {/* Title + delete */}
                <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-snug flex-1">
                        {feature.title}
                    </h3>
                    <button
                        onClick={handleDelete}
                        className="shrink-0 p-1 rounded text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Delete feature"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* Progress bar */}
                {feature.stepsTotal > 0 && (
                    <ProgressBar
                        current={feature.stepsComplete}
                        total={feature.stepsTotal}
                    />
                )}

                {/* Status + time */}
                <div className="flex items-center justify-between">
                    <FeatureStatusBadge status={feature.status} />
                    <RelativeTime
                        timestamp={feature.updatedAt}
                        className="text-[10px] text-muted-foreground"
                    />
                </div>
            </Link>

            {/* Inline response for blocked features */}
            {isBlocked && feature.needsInput !== undefined && (
                <div className="pt-1 border-t border-orange-500/20 space-y-2">
                    <p className="text-xs text-orange-200 line-clamp-2">
                        {feature.needsInput.question}
                    </p>
                    <div className="flex gap-1.5">
                        <input
                            type="text"
                            value={response}
                            onChange={(e) => setResponse(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleRespond()}
                            placeholder="Reply..."
                            className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                            onClick={(e) => e.preventDefault()} // Prevent Link navigation
                        />
                        <button
                            onClick={(e) => { e.preventDefault(); handleRespond(); }}
                            disabled={response.trim() === ''}
                            className="p-1 rounded bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
                        >
                            <Send className="w-3 h-3" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
