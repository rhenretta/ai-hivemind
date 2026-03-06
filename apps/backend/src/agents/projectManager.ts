/**
 * projectManager.ts — Project Manager Agent
 *
 * Thin wrapper that delegates to TaskOrchestrator — the real RPIV engine.
 * The TaskOrchestrator handles decomposition, dependency ordering, Claude Code
 * CLI integration, and QA validation per task node.
 *
 * Keeping this class preserves the external API expected by the Coordinator.
 */

import { v4 as uuidv4 } from 'uuid';

import { BaseAgent } from './baseAgent.js';
import { TaskOrchestrator } from './taskOrchestrator.js';

export class ProjectManager extends BaseAgent {
    constructor(agentId: string, traceId: string) {
        super(agentId, traceId);
    }

    async run(objective: string): Promise<string> {
        this.spawn('project-manager');
        this.emit('STATE_CHANGED', {
            message: `Project Manager delegating to TaskOrchestrator: "${objective.slice(0, 100)}"`,
            phase: 'start',
        });

        const orchestratorId = `task-orchestrator.${uuidv4().slice(0, 8)}`;
        const orchestrator = new TaskOrchestrator(orchestratorId, this.traceId);

        const result = await orchestrator.run(objective);

        this.terminate('task_complete');
        return result;
    }
}
