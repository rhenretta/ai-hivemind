'use client';

import { CheckCircle, XCircle, Circle, Loader2, SkipForward, ClipboardList } from 'lucide-react';
import { useState } from 'react';

interface TestItem {
    id: string;
    name: string;
    description?: string;
    type: string;
    status: string;
    result?: string;
}

interface QaTestPlanRendererProps {
    plan: { tests: TestItem[] };
}

const STATUS_ICON: Record<string, React.ReactNode> = {
    passed: <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />,
    failed: <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />,
    running: <Loader2 className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-spin" />,
    skipped: <SkipForward className="w-3.5 h-3.5 text-slate-400 shrink-0" />,
    pending: <Circle className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />,
};

const STATUS_BADGE: Record<string, string> = {
    passed: 'bg-emerald-500/10 text-emerald-400',
    failed: 'bg-red-500/10 text-red-400',
    running: 'bg-blue-500/10 text-blue-400',
    skipped: 'bg-slate-500/10 text-slate-400',
    pending: 'bg-muted/30 text-muted-foreground',
};

export function QaTestPlanRenderer({ plan }: QaTestPlanRendererProps) {
    const [expanded, setExpanded] = useState(false);

    const tests = plan.tests;
    const counts = {
        passed: tests.filter((t) => t.status === 'passed').length,
        failed: tests.filter((t) => t.status === 'failed').length,
        running: tests.filter((t) => t.status === 'running').length,
        pending: tests.filter((t) => t.status === 'pending').length,
        skipped: tests.filter((t) => t.status === 'skipped').length,
    };

    const parts: string[] = [];
    if (counts.passed > 0) parts.push(`${counts.passed} passed`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.running > 0) parts.push(`${counts.running} running`);
    if (counts.pending > 0) parts.push(`${counts.pending} pending`);
    if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);

    return (
        <div className="space-y-2">
            <button
                onClick={() => setExpanded(!expanded)}
                className="inline-flex items-center gap-1.5 text-[11px] text-lime-400 hover:text-lime-300 transition-colors"
            >
                <ClipboardList className="w-3.5 h-3.5" />
                {expanded ? 'Hide' : 'Show'} test plan ({tests.length} tests: {parts.join(', ')})
            </button>
            {expanded && (
                <div className="space-y-1 pl-1">
                    {tests.map((test) => (
                        <div key={test.id} className="flex items-start gap-2 py-1">
                            {STATUS_ICON[test.status] ?? STATUS_ICON['pending']}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-foreground/80 truncate">{test.name}</span>
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${STATUS_BADGE[test.status] ?? STATUS_BADGE['pending']}`}>
                                        {test.status}
                                    </span>
                                    <span className="text-[9px] text-muted-foreground/50 font-mono">{test.type}</span>
                                </div>
                                {test.status === 'failed' && test.result !== undefined && test.result !== '' && (
                                    <p className="text-[10px] text-red-300/70 mt-0.5 whitespace-pre-wrap break-words">
                                        {test.result}
                                    </p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
