'use client';

import { Check, ListChecks, MessageSquare } from 'lucide-react';
import { useCallback } from 'react';
import { v4 as uuid } from 'uuid';

import { getSocket } from '@/hooks/useSocket';
import { useChatStore, type FeatureProposal } from '@/stores/chatStore';
import { useFeatureStore } from '@/stores/featureStore';

interface FeatureProposalCardProps {
    messageId: string;
    traceId: string;
    proposal: FeatureProposal;
}

export function FeatureProposalCard({ messageId, traceId, proposal }: FeatureProposalCardProps) {
    const updateMessage = useChatStore((s) => s.updateMessage);
    const appendMessage = useChatStore((s) => s.appendMessage);
    const updateFeatureStatus = useFeatureStore((s) => s.updateFeatureStatus);

    const handleApprove = useCallback(() => {
        updateMessage(messageId, {
            proposal: { ...proposal, status: 'approved' },
        });
        appendMessage({
            id: uuid(),
            role: 'user',
            text: 'Sounds good, go ahead!',
            timestamp: new Date().toISOString(),
            traceId,
            type: 'text',
        });
        updateFeatureStatus(traceId, 'in_progress');
        useChatStore.getState().setAiTyping(true);

        const ws = getSocket();
        ws.emit('user:intervention', {
            text: 'APPROVED',
            targetId: 'coordinator',
            traceId,
        });
    }, [messageId, traceId, proposal, updateMessage, appendMessage, updateFeatureStatus]);

    const isApproved = proposal.status === 'approved';

    return (
        <div className={`rounded-xl border ${isApproved ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border/50 bg-card'} p-4 space-y-3`}>
            <div className="flex items-center gap-2">
                <ListChecks className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">{proposal.title}</span>
                {isApproved && (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-400">
                        <Check className="w-3 h-3" />
                        Approved
                    </span>
                )}
            </div>

            {proposal.description !== '' && (
                <p className="text-sm text-muted-foreground">{proposal.description}</p>
            )}

            {proposal.steps.length > 0 && (
                <div className="space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Plan:</p>
                    <ol className="list-decimal list-inside text-sm text-foreground/80 space-y-0.5">
                        {proposal.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                        ))}
                    </ol>
                </div>
            )}

            {!isApproved && (
                <div className="flex gap-2 pt-1">
                    <button
                        onClick={handleApprove}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                        Approve
                    </button>
                    <button
                        onClick={() => {/* Focus chat input for discussion */}}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <MessageSquare className="w-3 h-3 inline mr-1" />
                        Let&apos;s discuss
                    </button>
                </div>
            )}
        </div>
    );
}
