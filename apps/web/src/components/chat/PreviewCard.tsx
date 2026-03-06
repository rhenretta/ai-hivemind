'use client';

import { ExternalLink, Eye } from 'lucide-react';
import Link from 'next/link';

interface PreviewCardProps {
    traceId: string;
    text: string;
    previewUrl?: string | undefined;
}

export function PreviewCard({ traceId, text, previewUrl }: PreviewCardProps) {
    return (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-300">{text}</span>
            </div>

            <div className="flex gap-2">
                <Link
                    href={`/features/${traceId}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                >
                    <Eye className="w-3 h-3" />
                    View preview
                </Link>
                {previewUrl !== undefined && previewUrl !== '' && (
                    <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <ExternalLink className="w-3 h-3" />
                        Open in new tab
                    </a>
                )}
            </div>
        </div>
    );
}
