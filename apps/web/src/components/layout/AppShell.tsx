'use client';

import { type ReactNode } from 'react';

import { NavBar } from './NavBar';

interface AppShellProps {
    children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
    return (
        <div className="flex h-screen overflow-hidden">
            <NavBar />
            <main className="flex-1 overflow-hidden">
                {children}
            </main>
        </div>
    );
}
