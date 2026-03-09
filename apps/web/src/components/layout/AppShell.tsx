'use client';

import { type ReactNode } from 'react';

import { SessionSidebar } from './SessionSidebar';

interface AppShellProps {
    children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
    return (
        <div className="flex h-screen overflow-hidden">
            <SessionSidebar />
            <main className="flex-1 overflow-hidden">
                {children}
            </main>
        </div>
    );
}
