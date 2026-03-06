'use client';

import { useChatStore, selectMessages, selectIsAiTyping } from '@/stores/chatStore';

import { ChatInput } from './ChatInput';
import { MessageList } from './MessageList';
import { NotificationBanner } from './NotificationBanner';

export function ChatView() {
    const messages = useChatStore(selectMessages);
    const isAiTyping = useChatStore(selectIsAiTyping);

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/50">
                <h1 className="text-lg font-semibold text-foreground">AI Hivemind</h1>
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
