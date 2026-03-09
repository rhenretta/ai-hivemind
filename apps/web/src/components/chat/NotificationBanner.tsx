'use client';

import { AlertCircle, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { useNotificationStore } from '@/stores/notificationStore';
import { useSessionStore } from '@/stores/sessionStore';

export function NotificationBanner() {
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const notifications = useNotificationStore((s) => s.notifications);
    const setActiveSession = useSessionStore((s) => s.setActiveSession);

    const activeNotifications = notifications.filter(
        (n) => n.type === 'needs_input' && !n.read && !dismissed.has(n.id),
    );

    const latest = activeNotifications[0];

    const handleRespond = useCallback(() => {
        if (latest === undefined) return;
        setActiveSession(latest.featureId);
    }, [latest, setActiveSession]);

    if (latest === undefined) return null;

    return (
        <div className="shrink-0 mx-6 mb-2">
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-orange-500/10 border border-orange-500/20">
                <AlertCircle className="w-4 h-4 text-orange-400 shrink-0" />
                <span className="flex-1 text-sm text-orange-200 truncate">
                    <span className="font-medium">{latest.featureTitle}</span>
                    {' '}needs your input
                </span>
                <button
                    onClick={handleRespond}
                    className="text-xs font-medium text-orange-400 hover:text-orange-300 transition-colors whitespace-nowrap"
                >
                    Respond
                </button>
                <button
                    onClick={() => setDismissed((prev) => new Set(prev).add(latest.id))}
                    className="text-orange-400/50 hover:text-orange-400 transition-colors"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}
