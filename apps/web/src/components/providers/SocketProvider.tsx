'use client';

import { type ReactNode } from 'react';

import { useSocket } from '@/hooks/useSocket';

interface SocketProviderProps {
    children: ReactNode;
}

export function SocketProvider({ children }: SocketProviderProps) {
    useSocket();
    // eslint-disable-next-line react/jsx-no-useless-fragment
    return <>{children}</>;
}
