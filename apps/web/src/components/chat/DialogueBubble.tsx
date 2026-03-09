'use client';

import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';

import { type ChatMessage } from '@/stores/chatStore';

/** Map tool names to friendlier labels */
const TOOL_LABELS: Record<string, string> = {
    get_all_features: 'All features',
    get_task_status: 'Task status',
    get_qa_results: 'QA results',
    get_design_spec: 'Design spec',
    get_execution_log: 'Execution log',
    query_codebase: 'Codebase query',
    query_knowledge_base: 'Knowledge base',
};

interface DialogueBubbleProps {
    message: ChatMessage;
}

export function DialogueBubble({ message }: DialogueBubbleProps) {
    const [sourcesExpanded, setSourcesExpanded] = useState(false);
    const sources = message.contextSources;
    const hasSources = sources !== undefined && sources.length > 0;

    return (
        <div className="rounded-2xl rounded-tl-md px-4 py-2.5 bg-card border border-border/50 text-sm text-foreground">
            {message.text}

            {hasSources && (
                <div className="mt-2 pt-2 border-t border-border/30">
                    <button
                        type="button"
                        onClick={() => { setSourcesExpanded(!sourcesExpanded); }}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {sourcesExpanded
                            ? <ChevronDown className="w-3 h-3" />
                            : <ChevronRight className="w-3 h-3" />}
                        <span>Context sources ({sources.length.toString()})</span>
                    </button>

                    {sourcesExpanded && (
                        <div className="mt-1.5 space-y-1">
                            {sources.map((source, i) => (
                                <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                                    <Search className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/60" />
                                    <span>
                                        <span className="font-medium text-muted-foreground/80">
                                            {TOOL_LABELS[source.tool] ?? source.tool}
                                        </span>
                                        {': '}
                                        {source.summary}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
