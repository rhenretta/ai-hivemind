'use client';

import { AlertCircle, Send } from 'lucide-react';
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';

import { getSocket } from '@/hooks/useSocket';
import { useChatStore, type ClarificationData } from '@/stores/chatStore';
import { useSessionStore } from '@/stores/sessionStore';

interface ClarificationCardProps {
    messageId: string;
    traceId: string;
    clarification: ClarificationData;
}

export function ClarificationCard({ messageId, traceId, clarification }: ClarificationCardProps) {
    const [response, setResponse] = useState('');
    const updateMessage = useChatStore((s) => s.updateMessage);
    const appendMessage = useChatStore((s) => s.appendMessage);
    const clearSessionNeedsInput = useSessionStore((s) => s.clearSessionNeedsInput);

    const handleSubmit = useCallback(() => {
        if (response.trim() === '') return;

        updateMessage(messageId, {
            clarification: { ...clarification, responded: true, response: response.trim() },
        });
        appendMessage({
            id: uuid(),
            role: 'user',
            text: response.trim(),
            timestamp: new Date().toISOString(),
            traceId,
            type: 'text',
        });
        clearSessionNeedsInput(traceId);
        useChatStore.getState().setAiTyping(true);

        const ws = getSocket();
        ws.emit('user:intervention', {
            text: response.trim(),
            targetId: 'conductor',
            traceId,
        });

        setResponse('');
    }, [response, messageId, traceId, clarification, updateMessage, appendMessage, clearSessionNeedsInput]);

    if (clarification.responded) {
        return (
            <div className="rounded-xl border border-border/30 bg-card/50 p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="w-4 h-4" />
                    <span>{clarification.question}</span>
                </div>
                <p className="text-sm text-foreground/70 italic">
                    You answered: {clarification.response}
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-orange-400" />
                <span className="text-sm font-medium text-orange-300">Needs your input</span>
            </div>
            <p className="text-sm text-foreground">{clarification.question}</p>
            <div className="flex gap-2">
                <input
                    type="text"
                    value={response}
                    onChange={(e) => setResponse(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                    placeholder="Type your answer..."
                    className="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                    onClick={handleSubmit}
                    disabled={response.trim() === ''}
                    className="px-3 py-1.5 rounded-lg bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
                >
                    <Send className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
