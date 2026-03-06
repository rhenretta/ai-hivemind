'use client';

/**
 * LlmCallRenderer — Split-pane view for LLM call events
 *
 * Top section: system_prompt + user_prompt (scrollable)
 * Bottom section: response — with JSON syntax highlighting if parseable, else plain
 */

import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

interface LlmCallRendererProps {
    systemPrompt?: string | undefined;
    userPrompt?: string | undefined;
    response?: string | undefined;
    model?: string | undefined;
    tokenUsage?: { prompt?: number | undefined; completion?: number | undefined; total?: number | undefined } | undefined;
}

function isJson(s: string): boolean {
    try { JSON.parse(s); return true; } catch { return false; }
}

function PromptBlock({ label, content }: { label: string; content: string }) {
    const [expanded, setExpanded] = useState(true);
    return (
        <div className="rounded-md border border-border/30 overflow-hidden">
            <button
                type="button"
                onClick={() => { setExpanded(!expanded); }}
                className="w-full flex items-center justify-between px-3 py-2 bg-muted/20 hover:bg-muted/30 transition-colors text-left"
            >
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {label}
                </span>
                <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                    {content.length.toLocaleString()} chars {expanded ? '▲' : '▼'}
                </span>
            </button>
            {expanded && (
                <pre className="px-3 py-2.5 text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto bg-black/20 font-mono">
                    {content}
                </pre>
            )}
        </div>
    );
}

export function LlmCallRenderer({
    systemPrompt,
    userPrompt,
    response,
    model,
    tokenUsage,
}: LlmCallRendererProps) {
    return (
        <div className="flex flex-col gap-3 overflow-auto">
            {/* Meta row */}
            <div className="flex items-center gap-3 flex-wrap">
                {model !== undefined && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-violet-400/30 text-violet-400 bg-violet-400/10">
                        {model}
                    </span>
                )}
                {tokenUsage !== undefined && (
                    <span className="text-[10px] text-muted-foreground/50 font-mono">
                        {tokenUsage.prompt ?? 0}p + {tokenUsage.completion ?? 0}c = {tokenUsage.total ?? 0} tokens
                    </span>
                )}
            </div>

            {/* Prompt blocks */}
            {typeof systemPrompt === 'string' && systemPrompt.length > 0 && (
                <PromptBlock label="System Prompt" content={systemPrompt} />
            )}
            {typeof userPrompt === 'string' && userPrompt.length > 0 && (
                <PromptBlock label="User Prompt" content={userPrompt} />
            )}

            {/* Response */}
            {typeof response === 'string' && response.length > 0 && (
                <div className="rounded-md border border-border/30 overflow-hidden">
                    <div className="px-3 py-2 bg-muted/20 border-b border-border/30">
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400/80">
                            Response
                        </span>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {isJson(response) ? (
                            <SyntaxHighlighter
                                language="json"
                                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                                style={atomDark}
                                customStyle={{
                                    margin: 0,
                                    padding: '12px',
                                    background: 'rgba(0,0,0,0.3)',
                                    fontSize: '11px',
                                    lineHeight: '1.6',
                                }}
                                wrapLongLines
                            >
                                {response}
                            </SyntaxHighlighter>
                        ) : (
                            <pre className="px-3 py-2.5 text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed bg-black/20 font-mono">
                                {response}
                            </pre>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
