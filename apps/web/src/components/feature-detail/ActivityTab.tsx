'use client';

import { type SystemEvent } from '@ai-hivemind/shared';
import { useMemo } from 'react';

import { buildAgentTree } from '@/lib/agentTree';

import { AgentRow } from './AgentRow';

interface ActivityTabProps {
    events: SystemEvent[];
}

export function ActivityTab({ events }: ActivityTabProps) {
    const tree = useMemo(() => buildAgentTree(events), [events]);

    if (tree.length === 0) {
        return (
            <div className="flex items-center justify-center h-40">
                <p className="text-sm text-muted-foreground">No activity yet</p>
            </div>
        );
    }

    return (
        <div className="max-w-3xl space-y-0.5">
            {tree.map((node) => (
                <AgentRow key={node.agentId} node={node} />
            ))}
        </div>
    );
}
