'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { FileCode, Terminal as TerminalIcon } from 'lucide-react';
import { useState } from 'react';

import { JsonTreeRenderer } from '../../inspector/JsonTreeRenderer';

interface ToolUsedRendererProps {
    event: SystemEvent;
    nextEvent?: SystemEvent | undefined;
}

export function ToolUsedRenderer({ event, nextEvent }: ToolUsedRendererProps) {
    const source = typeof event.payload['source'] === 'string' ? event.payload['source'] : '';
    const toolName = typeof event.payload['toolName'] === 'string' ? event.payload['toolName'] : '';

    if (source === 'conductor:code_change') {
        return <CodeChangeRenderer event={event} />;
    }

    if (source === 'conductor:tool_result' || source === 'qa:tool_result') {
        return <ToolResultRenderer event={event} />;
    }

    // Default: tool invocation
    return <ToolInvocationRenderer event={event} nextEvent={nextEvent} toolName={toolName} />;
}

function CodeChangeRenderer({ event }: { event: SystemEvent }) {
    const filePath = typeof event.payload['filePath'] === 'string' ? event.payload['filePath'] : 'unknown';
    const description = typeof event.payload['description'] === 'string' ? event.payload['description'] : '';
    const fileName = filePath.split('/').pop() ?? filePath;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
                <FileCode className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="text-xs font-mono text-amber-300">{fileName}</span>
                {description !== '' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 break-words">
                        {description}
                    </span>
                )}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono break-all pl-5.5">
                {filePath}
            </div>
        </div>
    );
}

const OUTPUT_PREVIEW_THRESHOLD = 800;

function ToolResultRenderer({ event }: { event: SystemEvent }) {
    const [showFull, setShowFull] = useState(false);
    const output = typeof event.payload['output'] === 'string' ? event.payload['output'] : '';
    const status = typeof event.payload['status'] === 'string' ? event.payload['status'] : 'ok';
    const isError = status === 'error';
    const isScreenshot = output.startsWith('data:image/');
    const isLong = !isScreenshot && output.length > OUTPUT_PREVIEW_THRESHOLD;
    const displayOutput = isLong && !showFull ? `${output.slice(0, OUTPUT_PREVIEW_THRESHOLD)}…` : output;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Result</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    isError ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
                }`}>
                    {status}
                </span>
                {isLong && (
                    <span className="text-[10px] text-muted-foreground/60">
                        {output.length.toLocaleString()} chars
                    </span>
                )}
            </div>
            {isScreenshot && (
                <div className="rounded-md bg-black/20 border border-border/20 p-1 max-h-[500px] overflow-auto">
                    <img
                        src={output}
                        alt="QA screenshot"
                        className="w-full rounded"
                    />
                </div>
            )}
            {!isScreenshot && output !== '' && (
                <div className="rounded-md bg-black/20 border border-border/20 p-2 max-h-[500px] overflow-auto">
                    <pre className="text-[11px] text-foreground/70 font-mono whitespace-pre-wrap break-words">
                        {displayOutput}
                    </pre>
                    {isLong && (
                        <button
                            onClick={() => setShowFull((v) => !v)}
                            className="text-[10px] text-primary hover:text-primary/80 mt-1.5 sticky bottom-0"
                        >
                            {showFull ? 'Show less' : `Show full output (${output.length.toLocaleString()} chars)`}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function ToolInvocationRenderer({
    event,
    nextEvent,
    toolName,
}: {
    event: SystemEvent;
    nextEvent?: SystemEvent | undefined;
    toolName: string;
}) {
    const input = event.payload['input'] as Record<string, unknown> | undefined;
    const command = typeof event.payload['command'] === 'string' ? event.payload['command'] : '';
    const filePath = typeof event.payload['filePath'] === 'string' ? event.payload['filePath'] : '';
    const isBash = toolName.toLowerCase().includes('bash');
    const isFileOp = toolName === 'Edit' || toolName === 'Write' || toolName === 'Read';

    // Check if next event is the tool result (from conductor or QA)
    const hasResult = nextEvent !== undefined
        && nextEvent.eventType === 'TOOL_USED'
        && typeof nextEvent.payload['source'] === 'string'
        && (nextEvent.payload['source'] === 'conductor:tool_result' || nextEvent.payload['source'] === 'qa:tool_result');

    return (
        <div className="space-y-2">
            {/* Tool name badge */}
            <div className="flex items-start gap-2 flex-wrap">
                {isBash ? (
                    <TerminalIcon className="w-3.5 h-3.5 text-teal-400 shrink-0 mt-0.5" />
                ) : (
                    <FileCode className="w-3.5 h-3.5 text-teal-400 shrink-0 mt-0.5" />
                )}
                <span className="text-xs font-mono font-medium px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-400">
                    {toolName}
                </span>
                {filePath !== '' && (
                    <span className="text-[10px] text-muted-foreground font-mono break-all">
                        {filePath}
                    </span>
                )}
            </div>

            {/* Input section */}
            {isBash && command !== '' && (
                <div className="rounded-md bg-black/20 border border-border/20 p-2">
                    <pre className="text-[11px] text-teal-300/80 font-mono whitespace-pre-wrap break-words">
                        $ {command}
                    </pre>
                </div>
            )}

            {!isBash && isFileOp && filePath !== '' && input !== undefined && (
                <JsonTreeRenderer data={input} />
            )}

            {!isBash && !isFileOp && input !== undefined && (
                <JsonTreeRenderer data={input} />
            )}

            {/* Paired result */}
            {hasResult && (
                <div className="ml-4 border-l-2 border-border/30 pl-3">
                    <ToolResultRenderer event={nextEvent} />
                </div>
            )}
        </div>
    );
}
