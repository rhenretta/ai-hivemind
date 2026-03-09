'use client';

import {
    type MemoryEntry,
    type RagCollection,
    type SystemEvent,
} from '@ai-hivemind/shared';
import {
    Brain,
    ChevronDown,
    ChevronRight,
    Database,
    Filter,
    Link2,
    Loader2,
    Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const NERVE_CENTER_URL =
    process.env['NEXT_PUBLIC_NERVE_CENTER_URL'] ?? 'http://localhost:3001';

// ── Collection colors ───────────────────────────────────────────────────────

const DEFAULT_COLLECTION_STYLE = {
    border: 'border-l-gray-500',
    badge: 'bg-gray-500/20 text-gray-400',
} as const;

const COLLECTION_COLORS: Record<string, { border: string; badge: string }> = {
    'swe-outputs': {
        border: 'border-l-emerald-500',
        badge: 'bg-emerald-500/20 text-emerald-400',
    },
    'research-context': {
        border: 'border-l-blue-500',
        badge: 'bg-blue-500/20 text-blue-400',
    },
    'ux-designs': {
        border: 'border-l-violet-500',
        badge: 'bg-violet-500/20 text-violet-400',
    },
    default: DEFAULT_COLLECTION_STYLE,
};

function getCollectionStyle(name: string) {
    return COLLECTION_COLORS[name] ?? DEFAULT_COLLECTION_STYLE;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

function tryParseJson(content: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(content) as unknown;
        if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch { /* not JSON */ }

    // Try extracting JSON after a header line like "[SUCCESS] agent-id\n{...}"
    const jsonStart = content.indexOf('{');
    if (jsonStart > 0) {
        try {
            const parsed = JSON.parse(content.slice(jsonStart)) as unknown;
            if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
        } catch { /* not JSON */ }
    }
    return null;
}

// ── Props ───────────────────────────────────────────────────────────────────

interface MemoryTabProps {
    sessionId: string;
    events: SystemEvent[];
}

// ── Component ───────────────────────────────────────────────────────────────

export function MemoryTab({ sessionId, events }: MemoryTabProps) {
    const [entries, setEntries] = useState<MemoryEntry[]>([]);
    const [collections, setCollections] = useState<RagCollection[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Filters
    const [selectedCollection, setSelectedCollection] = useState<string>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    // Fetch data on mount
    useEffect(() => {
        setLoading(true);
        setError(null);
        Promise.all([
            fetch(`${NERVE_CENTER_URL}/api/rag/collections`).then((r) => r.json()) as Promise<RagCollection[]>,
            fetch(`${NERVE_CENTER_URL}/api/rag/entries?traceId=${sessionId}`).then((r) => r.json()) as Promise<MemoryEntry[]>,
        ])
            .then(([cols, ents]) => {
                setCollections(cols);
                setEntries(ents);
            })
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                setError(msg);
            })
            .finally(() => setLoading(false));
    }, [sessionId]);

    // Track new MEMORY_STORED events for live updates
    const memoryEventCount = useMemo(
        () => events.filter((e) => e.eventType === 'MEMORY_STORED').length,
        [events],
    );

    // Re-fetch when new memory events arrive (debounced by count)
    useEffect(() => {
        if (memoryEventCount === 0) return;
        fetch(`${NERVE_CENTER_URL}/api/rag/entries?traceId=${sessionId}`)
            .then((r) => r.json() as Promise<MemoryEntry[]>)
            .then(setEntries)
            .catch(() => { /* silent refresh failure */ });
    }, [memoryEventCount, sessionId]);

    // Derive unique tags from entries
    const allTags = useMemo(() => {
        const tagSet = new Set<string>();
        for (const entry of entries) {
            for (const tag of entry.tags) tagSet.add(tag);
        }
        return Array.from(tagSet).sort();
    }, [entries]);

    // Active collections (only those with entries)
    const activeCollections = useMemo(() => {
        const names = new Set(entries.map((e) => e.collectionName));
        return collections.filter((c) => names.has(c.name));
    }, [collections, entries]);

    // Filter entries
    const filteredEntries = useMemo(() => {
        let result = entries;
        if (selectedCollection !== 'all') {
            result = result.filter((e) => e.collectionName === selectedCollection);
        }
        if (searchQuery.trim().length > 0) {
            const lower = searchQuery.toLowerCase();
            result = result.filter(
                (e) =>
                    e.content.toLowerCase().includes(lower) ||
                    e.tags.some((t) => t.toLowerCase().includes(lower)) ||
                    e.agentId.toLowerCase().includes(lower),
            );
        }
        return result;
    }, [entries, selectedCollection, searchQuery]);

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading memory entries...
            </div>
        );
    }

    if (error !== null) {
        return (
            <div className="flex items-center justify-center py-20 text-red-400">
                Failed to load memory: {error}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                {/* Collection filter */}
                <div className="flex items-center gap-1.5 text-sm">
                    <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                    <select
                        value={selectedCollection}
                        onChange={(e) => setSelectedCollection(e.target.value)}
                        className="bg-card border border-border/50 rounded px-2 py-1 text-sm text-foreground"
                    >
                        <option value="all">All Collections</option>
                        {activeCollections.map((c) => (
                            <option key={c.name} value={c.name}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Search */}
                <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
                    <Search className="w-3.5 h-3.5 text-muted-foreground" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search content, tags, agent..."
                        className="bg-card border border-border/50 rounded px-2 py-1 text-sm text-foreground flex-1"
                    />
                </div>

                {/* Count badge */}
                <span className="text-xs text-muted-foreground">
                    {filteredEntries.length} of {entries.length} entries
                </span>
            </div>

            {/* Tag chips */}
            {allTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {allTags.map((tag) => (
                        <button
                            key={tag}
                            onClick={() => setSearchQuery(tag)}
                            className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-primary/10 text-primary
                                hover:bg-primary/20 transition-colors"
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}

            {/* Entry list */}
            {filteredEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Brain className="w-8 h-8 text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">
                        {entries.length === 0
                            ? 'No memory entries stored for this session yet.'
                            : 'No entries match your filters.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    {filteredEntries.map((entry) => (
                        <MemoryEntryCard
                            key={entry.memoryId}
                            entry={entry}
                            expanded={expandedIds.has(entry.memoryId)}
                            onToggle={toggleExpanded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── MemoryEntryCard ─────────────────────────────────────────────────────────

function MemoryEntryCard({
    entry,
    expanded,
    onToggle,
}: {
    entry: MemoryEntry;
    expanded: boolean;
    onToggle: (id: string) => void;
}) {
    const style = getCollectionStyle(entry.collectionName);
    const json = useMemo(() => tryParseJson(entry.content), [entry.content]);
    const hasLinks = entry.relatedMemoryIds.length > 0;

    return (
        <div
            className={`border-l-2 ${style.border} rounded-r-lg bg-card/50 border border-border/30 overflow-hidden`}
        >
            {/* Header (always visible) */}
            <button
                onClick={() => onToggle(entry.memoryId)}
                className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-secondary/30 transition-colors"
            >
                {expanded
                    ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                }
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${style.badge}`}>
                            {entry.collectionName}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                            {entry.agentId}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60">
                            {formatDate(entry.timestamp)}
                        </span>
                        {hasLinks && (
                            <span className="flex items-center gap-0.5 text-[10px] text-primary/70">
                                <Link2 className="w-2.5 h-2.5" />
                                {entry.relatedMemoryIds.length}
                            </span>
                        )}
                    </div>
                    {/* Content preview */}
                    {!expanded && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {json !== null && typeof json['subtask'] === 'string'
                                ? `[SWE] ${json['subtask']}`
                                : entry.content.slice(0, 200)}
                        </p>
                    )}
                </div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <div className="px-4 pb-3 border-t border-border/20">
                    {/* Tags */}
                    {entry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 mb-2">
                            {entry.tags.map((tag) => (
                                <span
                                    key={tag}
                                    className="px-1.5 py-0.5 text-[10px] rounded bg-secondary text-muted-foreground"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Task node link */}
                    {entry.taskNodeId !== undefined && (
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-2">
                            <Database className="w-3 h-3" />
                            Task: {entry.taskNodeId}
                        </div>
                    )}

                    {/* Content */}
                    {json !== null ? (
                        <SweArtifactContent json={json} />
                    ) : (
                        <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono bg-background/50 rounded p-3 max-h-96 overflow-y-auto">
                            {entry.content}
                        </pre>
                    )}
                </div>
            )}
        </div>
    );
}

// ── SWE Artifact structured rendering ───────────────────────────────────────

function SweArtifactContent({ json }: { json: Record<string, unknown> }) {
    const subtask = typeof json['subtask'] === 'string' ? json['subtask'] : null;
    const success = typeof json['success'] === 'boolean' ? json['success'] : null;
    const filesChanged = Array.isArray(json['filesChanged']) ? json['filesChanged'] as string[] : [];
    const summary = typeof json['summary'] === 'string' ? json['summary'] : null;
    const errors = Array.isArray(json['errors']) ? json['errors'] as string[] : [];

    return (
        <div className="space-y-2 mt-2">
            {subtask !== null && (
                <div className="text-sm font-medium text-foreground">{subtask}</div>
            )}
            {success !== null && (
                <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${
                    success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                }`}>
                    {success ? 'Success' : 'Failed'}
                </span>
            )}
            {filesChanged.length > 0 && (
                <div>
                    <div className="text-[10px] uppercase text-muted-foreground/60 mb-1">Files Changed</div>
                    <div className="space-y-0.5">
                        {filesChanged.map((f, i) => (
                            <div key={i} className="text-xs font-mono text-foreground/70">{f}</div>
                        ))}
                    </div>
                </div>
            )}
            {errors.length > 0 && (
                <div>
                    <div className="text-[10px] uppercase text-red-400/80 mb-1">Errors</div>
                    {errors.map((e, i) => (
                        <div key={i} className="text-xs text-red-400/70 font-mono">{e}</div>
                    ))}
                </div>
            )}
            {summary !== null && (
                <div className="text-xs text-foreground/70 mt-1">{summary}</div>
            )}
        </div>
    );
}
