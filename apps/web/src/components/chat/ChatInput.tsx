'use client';

import { Send } from 'lucide-react';
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';

import { getSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';

export function ChatInput() {
    const [text, setText] = useState('');
    const appendMessage = useChatStore((s) => s.appendMessage);
    const setAiTyping = useChatStore((s) => s.setAiTyping);

    const handleSubmit = useCallback(() => {
        const trimmed = text.trim();
        if (trimmed === '') return;

        const clientEventId = uuid();
        const timestamp = new Date().toISOString();

        // Optimistic: add user message to chat (no traceId yet — backend resolves it)
        appendMessage({
            id: clientEventId,
            role: 'user',
            text: trimmed,
            timestamp,
            type: 'text',
        });

        setAiTyping(true);

        // Send to backend for intent classification
        const ws = getSocket();
        ws.emit('user:message', {
            text: trimmed,
            clientEventId,
        });

        setText('');
    }, [text, appendMessage, setAiTyping]);

    return (
        <div className="shrink-0 px-6 py-4 border-t border-border/50">
            <div className="flex gap-2 max-w-3xl mx-auto">
                <input
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
                    placeholder="Describe a feature you'd like to build..."
                    className="flex-1 px-4 py-3 text-sm bg-secondary border border-border/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
                />
                <button
                    onClick={handleSubmit}
                    disabled={text.trim() === ''}
                    className="px-4 py-3 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                    <Send className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
