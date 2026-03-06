'use client';

import { useConnectionStore, selectConnectionStatus } from '@/stores/connectionStore';

export function ConnectionIndicator() {
    const status = useConnectionStore(selectConnectionStatus);

    const statusConfig = {
        connected: { color: 'bg-emerald-400', label: 'Connected' },
        connecting: { color: 'bg-amber-400 animate-pulse', label: 'Connecting...' },
        reconnecting: { color: 'bg-amber-400 animate-pulse', label: 'Reconnecting...' },
        disconnected: { color: 'bg-red-400', label: 'Disconnected' },
    };

    const config = statusConfig[status];

    return (
        <div className="flex items-center justify-center" title={config.label}>
            <div className={`w-2 h-2 rounded-full ${config.color}`} />
        </div>
    );
}
