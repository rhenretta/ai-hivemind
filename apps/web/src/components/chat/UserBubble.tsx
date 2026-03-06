import { type ChatMessage } from '@/stores/chatStore';

import { RelativeTime } from '../shared/RelativeTime';

interface UserBubbleProps {
    message: ChatMessage;
}

export function UserBubble({ message }: UserBubbleProps) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[75%] flex flex-col items-end gap-1">
                <div className="rounded-2xl rounded-br-md px-4 py-2.5 bg-primary text-primary-foreground text-sm">
                    {message.text}
                </div>
                <RelativeTime
                    timestamp={message.timestamp}
                    className="text-[10px] text-muted-foreground"
                />
            </div>
        </div>
    );
}
