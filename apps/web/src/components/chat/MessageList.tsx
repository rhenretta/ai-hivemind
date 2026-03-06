'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import { type ChatMessage } from '@/stores/chatStore';

import { AIBubble } from './AIBubble';
import { UserBubble } from './UserBubble';

interface MessageListProps {
    messages: ChatMessage[];
    isAiTyping: boolean;
}

export function MessageList({ messages, isAiTyping }: MessageListProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);

    const scrollToBottom = useCallback(() => {
        const el = containerRef.current;
        if (el !== null && !isUserScrolledUp.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages.length, scrollToBottom]);

    const handleScroll = useCallback(() => {
        const el = containerRef.current;
        if (el === null) return;
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        isUserScrolledUp.current = distFromBottom > 100;
    }, []);

    if (messages.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center">
                <div className="text-center max-w-md px-6">
                    <h2 className="text-xl font-semibold text-foreground mb-2">
                        What would you like to build?
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        Describe a feature you want for your site. I&apos;ll help you plan it out
                        and build it for you.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="flex-1 overflow-y-auto px-6 py-4 space-y-4"
            onScroll={handleScroll}
        >
            {messages.map((msg) =>
                msg.role === 'user' ? (
                    <UserBubble key={msg.id} message={msg} />
                ) : (
                    <AIBubble key={msg.id} message={msg} />
                ),
            )}

            {isAiTyping && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>AI is thinking...</span>
                </div>
            )}
        </div>
    );
}
