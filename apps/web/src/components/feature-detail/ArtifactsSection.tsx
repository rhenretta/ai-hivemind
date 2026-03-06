'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { FileCode, FolderOpen } from 'lucide-react';
import { useMemo } from 'react';

interface ArtifactsSectionProps {
    events: SystemEvent[];
}

interface FileArtifact {
    filePath: string;
    description: string;
    timestamp: string;
}

export function ArtifactsSection({ events }: ArtifactsSectionProps) {
    const artifacts = useMemo(() => {
        const byPath = new Map<string, FileArtifact>();
        for (const event of events) {
            if (event.eventType !== 'TOOL_USED') continue;
            const source = typeof event.payload['source'] === 'string' ? event.payload['source'] : '';
            if (source !== 'conductor:code_change') continue;
            const filePath = typeof event.payload['filePath'] === 'string' ? event.payload['filePath'] : '';
            if (filePath === '') continue;
            const description = typeof event.payload['description'] === 'string' ? event.payload['description'] : 'Modified';
            byPath.set(filePath, { filePath, description, timestamp: event.timestamp });
        }
        return [...byPath.values()];
    }, [events]);

    if (artifacts.length === 0) return null;

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-medium text-foreground">
                    Files changed
                </h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                    {artifacts.length}
                </span>
            </div>
            <div className="space-y-1">
                {artifacts.map((artifact) => {
                    const fileName = artifact.filePath.split('/').pop() ?? artifact.filePath;
                    return (
                        <div
                            key={artifact.filePath}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors"
                        >
                            <FileCode className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
                            <span className="text-xs font-mono text-foreground/80 truncate flex-1" title={artifact.filePath}>
                                {fileName}
                            </span>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                                {artifact.description}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
