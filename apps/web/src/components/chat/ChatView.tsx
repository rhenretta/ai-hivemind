'use client';

import { Trash2 } from 'lucide-react';
import { useCallback } from 'react';

import { useChatStore, selectMessages, selectIsAiTyping } from '@/stores/chatStore';

import { ChatInput } from './ChatInput';
import { MessageList } from './MessageList';
import { NotificationBanner } from './NotificationBanner';

export function ChatView() {
    const messages = useChatStore(selectMessages);
    const isAiTyping = useChatStore(selectIsAiTyping);
    const clearMessages = useChatStore((s) => s.clearMessages);

    const handleClear = useCallback(() => {
        clearMessages();
    }, [clearMessages]);

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/50">
                <h1 className="text-lg font-semibold text-foreground">AI Hivemind</h1>
                {messages.length > 0 && (
                    <button
                        onClick={handleClear}
                        title="Clear chat history"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                )}
            </div>

            {/* Messages */}
            <MessageList messages={messages} isAiTyping={isAiTyping} />

            {/* Notification banner for blocked features */}
            <NotificationBanner />

            {/* Input */}
            <ChatInput />
        </div>
    );
}
