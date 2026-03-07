'use client';

import { ExternalLink, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useState } from 'react';

interface PreviewTabProps {
    url: string;
}

type DeviceSize = 'desktop' | 'tablet' | 'mobile';

const DEVICE_SIZES: Record<DeviceSize, { width: string; label: string; icon: typeof Monitor }> = {
    desktop: { width: '100%', label: 'Desktop', icon: Monitor },
    tablet: { width: '768px', label: 'Tablet', icon: Tablet },
    mobile: { width: '375px', label: 'Mobile', icon: Smartphone },
};

export function PreviewTab({ url }: PreviewTabProps) {
    const [device, setDevice] = useState<DeviceSize>('desktop');
    const config = DEVICE_SIZES[device];

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border/50 bg-card">
                <div className="flex gap-1">
                    {(Object.entries(DEVICE_SIZES) as [DeviceSize, typeof config][]).map(
                        ([key, { label, icon: Icon }]) => (
                            <button
                                key={key}
                                onClick={() => setDevice(key)}
                                className={`p-1.5 rounded-md transition-colors ${device === key
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-muted-foreground hover:text-foreground'
                                }`}
                                title={label}
                            >
                                <Icon className="w-4 h-4" />
                            </button>
                        ),
                    )}
                </div>
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                    Open in new tab
                    <ExternalLink className="w-3 h-3" />
                </a>
            </div>

            {/* iframe container */}
            <div className="flex-1 flex justify-center bg-background/50 overflow-hidden">
                <div
                    className="h-full transition-all duration-300 border-x border-border/30"
                    style={{ width: config.width, maxWidth: '100%' }}
                >
                    {/*
                      No sandbox attribute: The preview URL is always on a different port
                      (different origin) from the parent app, so the browser's same-origin
                      policy already prevents it from accessing parent DOM, cookies, or storage.
                      The sandbox attribute was causing CSS injection failures in Next.js dev
                      mode — even with allow-scripts + allow-same-origin, Tailwind/PostCSS
                      styles weren't loading inside the sandboxed iframe.
                    */}
                    <iframe
                        src={url}
                        className="w-full h-full border-0 bg-white"
                        title="Feature preview"
                    />
                </div>
            </div>
        </div>
    );
}
