'use client';

import { type ChatMessage } from '@/stores/chatStore';

interface DialogueBubbleProps {
    message: ChatMessage;
}

export function DialogueBubble({ message }: DialogueBubbleProps) {
    return (
        <div className="rounded-2xl rounded-tl-md px-4 py-2.5 bg-card border border-border/50 text-sm text-foreground">
            {message.text}
        </div>
    );
}
