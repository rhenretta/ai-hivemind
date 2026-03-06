'use client';

import { Sparkles } from 'lucide-react';

import { type ChatMessage } from '@/stores/chatStore';

import { RelativeTime } from '../shared/RelativeTime';

import { ClarificationCard } from './ClarificationCard';
import { FeatureProgressCard } from './FeatureProgressCard';
import { FeatureProposalCard } from './FeatureProposalCard';
import { PreviewCard } from './PreviewCard';

interface AIBubbleProps {
    message: ChatMessage;
}

export function AIBubble({ message }: AIBubbleProps) {
    return (
        <div className="flex gap-3">
            {/* Avatar */}
            <div className="shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-primary" />
            </div>

            <div className="flex-1 max-w-[75%] flex flex-col gap-1">
                {/* Message text */}
                {message.type === 'text' && (
                    <div className="rounded-2xl rounded-tl-md px-4 py-2.5 bg-card border border-border/50 text-sm text-foreground">
                        {message.text}
                    </div>
                )}

                {/* Feature proposal */}
                {message.type === 'proposal' && message.proposal !== undefined && message.traceId !== undefined && (
                    <FeatureProposalCard
                        messageId={message.id}
                        traceId={message.traceId}
                        proposal={message.proposal}
                    />
                )}

                {/* Progress */}
                {message.type === 'progress' && message.traceId !== undefined && (
                    <FeatureProgressCard traceId={message.traceId} />
                )}

                {/* Clarification */}
                {message.type === 'clarification' && message.clarification !== undefined && message.traceId !== undefined && (
                    <ClarificationCard
                        messageId={message.id}
                        traceId={message.traceId}
                        clarification={message.clarification}
                    />
                )}

                {/* Preview */}
                {message.type === 'preview' && message.traceId !== undefined && (
                    <PreviewCard
                        traceId={message.traceId}
                        text={message.text}
                        previewUrl={message.previewUrl}
                    />
                )}

                <RelativeTime
                    timestamp={message.timestamp}
                    className="text-[10px] text-muted-foreground"
                />
            </div>
        </div>
    );
}
