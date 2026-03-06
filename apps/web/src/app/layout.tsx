import { type Metadata } from 'next';
import { Inter } from 'next/font/google';

import { AppShell } from '@/components/layout/AppShell';
import { SocketProvider } from '@/components/providers/SocketProvider';

import './globals.css';

const inter = Inter({
    subsets: ['latin'],
    variable: '--font-inter',
    display: 'swap',
});

export const metadata: Metadata = {
    title: 'AI Hivemind',
    description: 'Build your site with AI. Strategize, approve, and monitor features through conversation.',
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className={`dark ${inter.variable}`} suppressHydrationWarning>
            <body className="min-h-screen bg-background text-foreground overflow-hidden">
                <SocketProvider>
                    <AppShell>
                        {children}
                    </AppShell>
                </SocketProvider>
            </body>
        </html>
    );
}
