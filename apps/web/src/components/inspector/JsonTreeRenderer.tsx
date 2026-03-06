'use client';

/**
 * JsonTreeRenderer — Recursive collapsible JSON tree
 *
 * No external dependencies — pure React.
 * Color-codes by JS type: string=green, number=amber, boolean=pink, null=slate.
 */

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

type JsonValue =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JsonValue }
    | JsonValue[];

interface JsonNodeProps {
    value: JsonValue;
    depth?: number;
}

function JsonNode({ value, depth = 0 }: JsonNodeProps) {
    const [open, setOpen] = useState(depth < 2);

    if (value === null) {
        return <span className="text-slate-400 font-mono text-xs">null</span>;
    }

    if (typeof value === 'boolean') {
        return <span className="text-pink-400 font-mono text-xs">{value.toString()}</span>;
    }

    if (typeof value === 'number') {
        return <span className="text-amber-400 font-mono text-xs">{value}</span>;
    }

    if (typeof value === 'string') {
        const display = value.length > 120 ? `${value.slice(0, 120)}…` : value;
        return (
            <span className="text-emerald-400 font-mono text-xs break-all">
                &quot;{display}&quot;
            </span>
        );
    }

    // Array
    if (Array.isArray(value)) {
        if (value.length === 0) return <span className="text-muted-foreground/50 font-mono text-xs">[]</span>;
        return (
            <span className="inline-block">
                <button
                    type="button"
                    onClick={() => { setOpen(!open); }}
                    className="inline-flex items-center gap-0.5 text-muted-foreground/60 hover:text-foreground transition-colors"
                >
                    <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                    <span className="font-mono text-xs text-slate-400">[{value.length}]</span>
                </button>
                {open && (
                    <div className="pl-4 border-l border-border/30 mt-1 flex flex-col gap-1">
                        {value.map((item, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                                <span className="text-slate-600 font-mono text-xs shrink-0 w-4 text-right">{i}</span>
                                <span className="text-muted-foreground/40 font-mono text-xs shrink-0">:</span>
                                <JsonNode value={item} depth={depth + 1} />
                            </div>
                        ))}
                    </div>
                )}
            </span>
        );
    }

    // Object
    const keys = Object.keys(value);
    if (keys.length === 0) return <span className="text-muted-foreground/50 font-mono text-xs">{'{}'}</span>;

    return (
        <span className="inline-block w-full">
            <button
                type="button"
                onClick={() => { setOpen(!open); }}
                className="inline-flex items-center gap-0.5 text-muted-foreground/60 hover:text-foreground transition-colors"
            >
                <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                <span className="font-mono text-xs text-slate-400">{`{${keys.length}}`}</span>
            </button>
            {open && (
                <div className="pl-4 border-l border-border/30 mt-1 flex flex-col gap-1">
                    {keys.map((key) => (
                        <div key={key} className="flex items-start gap-1.5 min-w-0">
                            <span className="text-cyan-300/70 font-mono text-xs shrink-0">{key}</span>
                            <span className="text-muted-foreground/40 font-mono text-xs shrink-0">:</span>
                            <span className="min-w-0">
                                <JsonNode value={value[key] as JsonValue} depth={depth + 1} />
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </span>
    );
}

interface JsonTreeRendererProps {
    data: Record<string, unknown>;
}

export function JsonTreeRenderer({ data }: JsonTreeRendererProps) {
    return (
        <div className="rounded-md bg-black/30 border border-border/30 p-3 overflow-auto max-h-full">
            <JsonNode value={data as unknown as JsonValue} />
        </div>
    );
}
