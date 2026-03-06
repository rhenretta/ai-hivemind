'use client';

import { Globe, LayoutGrid, MessageSquare, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useFeatureStore, selectBlockedCount, type Feature } from '@/stores/featureStore';

import { ConnectionIndicator } from './ConnectionIndicator';

interface LiveRoute {
    href: string;
    label: string;
}

function getLiveRoutes(): LiveRoute[] {
    const features = useFeatureStore.getState().features;
    return Object.values(features)
        .filter((f): f is Feature & { route: string } => f.status === 'live' && f.route !== undefined)
        .map((f) => ({
            href: f.route,
            label: f.title.length > 12 ? `${f.title.slice(0, 11)}\u2026` : f.title,
        }));
}

export function NavBar() {
    const pathname = usePathname();
    const blockedCount = useFeatureStore(selectBlockedCount);
    const [liveRoutes, setLiveRoutes] = useState<LiveRoute[]>([]);

    useEffect(() => {
        // Read initial state
        setLiveRoutes(getLiveRoutes());

        // Subscribe to store changes
        const unsub = useFeatureStore.subscribe(() => {
            setLiveRoutes(getLiveRoutes());
        });
        return unsub;
    }, []);

    const navItems = [
        {
            href: '/',
            icon: MessageSquare,
            label: 'Chat',
            isActive: pathname === '/',
        },
        {
            href: '/features',
            icon: LayoutGrid,
            label: 'Features',
            isActive: pathname.startsWith('/features'),
            badge: blockedCount > 0 ? blockedCount : undefined,
        },
        ...liveRoutes.map((r) => ({
            href: r.href,
            icon: Globe,
            label: r.label,
            isActive: pathname.startsWith(r.href),
        })),
    ];

    return (
        <nav className="w-16 shrink-0 flex flex-col items-center border-r border-border/50 bg-card py-4 gap-2">
            {/* Logo */}
            <div className="mb-4 flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
                <Sparkles className="w-5 h-5 text-primary" />
            </div>

            {/* Nav items */}
            <div className="flex flex-col gap-1 flex-1">
                {navItems.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={`
                            relative flex items-center justify-center w-10 h-10 rounded-lg
                            transition-colors duration-150
                            ${item.isActive
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                            }
                        `}
                        title={item.label}
                    >
                        <item.icon className="w-5 h-5" />
                        {item.badge !== undefined && (
                            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-orange-500 text-white text-[10px] font-bold px-1">
                                {item.badge}
                            </span>
                        )}
                    </Link>
                ))}
            </div>

            {/* Connection status */}
            <ConnectionIndicator />
        </nav>
    );
}
