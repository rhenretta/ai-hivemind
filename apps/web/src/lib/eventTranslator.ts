import { type SystemEvent } from '@ai-hivemind/shared';

/**
 * Translates a raw SystemEvent into a user-friendly activity summary.
 * Returns null for events that should be hidden from non-technical users.
 */
export function translateEvent(event: SystemEvent): string | null {
    const { eventType, payload } = event;

    switch (eventType) {
        case 'USER_COMMAND':
            return null; // Shown as chat message, not activity

        case 'USER_INTERVENTION':
            return null; // Shown as chat message, not activity

        case 'STATE_CHANGED': {
            if (payload['taskComplete'] === true) {
                return 'Finished working on this feature';
            }
            if (payload['awaitingApproval'] === true) {
                return null; // Shown as proposal card
            }
            const state = typeof payload['state'] === 'string' ? payload['state'] : null;
            if (state === 'PLANNING') return 'Planning the approach...';
            if (state === 'EXECUTING') return 'Working on it...';
            return null;
        }

        case 'TOOL_USED': {
            const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : '';
            const source = typeof payload['source'] === 'string' ? payload['source'] : '';
            const command = typeof payload['command'] === 'string' ? payload['command'] : '';
            const filePath = typeof payload['filePath'] === 'string' ? payload['filePath'] : '';

            // Code change events — show the filename
            if (source === 'conductor:code_change' && filePath !== '') {
                const fileName = filePath.split('/').pop() ?? filePath;
                return `Modified ${fileName}`;
            }

            // Tool result events — show status
            if (source === 'conductor:tool_result') {
                const status = typeof payload['status'] === 'string' ? payload['status'] : 'ok';
                return status === 'error' ? 'Tool returned an error' : 'Tool completed';
            }

            if (toolName.includes('read') || toolName.includes('Read'))
                return `Reading ${filePath !== '' ? filePath.split('/').pop() ?? 'file' : 'codebase'}...`;
            if (toolName.includes('write') || toolName.includes('Write') || toolName.includes('Edit'))
                return `Writing ${filePath !== '' ? filePath.split('/').pop() ?? 'file' : 'code'}...`;
            if (command !== '' && command.includes('test'))
                return 'Running tests...';
            if (toolName.includes('Bash') || toolName.includes('bash')) {
                const shortCmd = command.length > 40 ? `${command.slice(0, 40)}...` : command;
                return shortCmd !== '' ? `Running: ${shortCmd}` : 'Running a command...';
            }
            return `Using tool: ${toolName}`;
        }

        case 'TASK_PLAN_CREATED':
            return 'Created a work plan';

        case 'TASK_GRAPH_UPDATED':
            return 'Updated the work plan';

        case 'TASK_NODE_COMPLETED': {
            const status = payload['status'] as string | undefined;
            const nodeId = typeof payload['nodeId'] === 'string' ? payload['nodeId'] : '';
            if (status === 'done') return `Completed step ${nodeId}`;
            if (status === 'failed') return `Step ${nodeId} ran into a problem`;
            return `Step ${nodeId} updated`;
        }

        case 'QA_VERDICT': {
            const passed = payload['passed'] === true;
            if (passed) return 'Quality check passed';
            const issues = Array.isArray(payload['issues']) ? payload['issues'] : [];
            return issues.length > 0
                ? `Found ${issues.length} issue${issues.length === 1 ? '' : 's'}, fixing...`
                : 'Found some issues, fixing...';
        }

        case 'SERVICE_DEPLOYED':
            return 'Preview is ready!';

        case 'FEATURE_DEPLOYED': {
            const routes = Array.isArray(payload['routes']) ? payload['routes'] as string[] : [];
            return routes.length > 0
                ? `Feature deployed at ${routes[0]}`
                : 'Feature deployed!';
        }

        case 'AGENT_INPUT_REQUIRED': {
            const question = typeof payload['question'] === 'string'
                ? payload['question']
                : typeof payload['text'] === 'string'
                    ? payload['text']
                    : 'Has a question for you';
            return `Needs your input: ${question}`;
        }

        case 'ERROR': {
            const message = typeof payload['message'] === 'string'
                ? payload['message']
                : 'Something went wrong';
            return `Problem: ${message}`;
        }

        // Hidden events — return null
        case 'AGENT_SPAWNED':
        case 'AGENT_TERMINATED':
        case 'MESSAGE_SENT':
        case 'CONDUCTOR_STREAM':
        case 'TOOL_REGISTERED':
        case 'MEMORY_STORED':
        case 'MEMORY_DELETED':
        case 'RAG_STORE_CREATED':
        case 'CREDENTIAL_STORED':
        case 'CREDENTIAL_DELETED':
            return null;

        default:
            return null;
    }
}

/**
 * Returns an activity type for styling purposes.
 */
export function getActivityType(event: SystemEvent): 'info' | 'progress' | 'success' | 'error' | 'question' {
    switch (event.eventType) {
        case 'QA_VERDICT':
            return event.payload['passed'] === true ? 'success' : 'error';
        case 'SERVICE_DEPLOYED':
        case 'FEATURE_DEPLOYED':
            return 'success';
        case 'TASK_NODE_COMPLETED':
            return event.payload['status'] === 'done' ? 'success' : 'error';
        case 'AGENT_INPUT_REQUIRED':
            return 'question';
        case 'ERROR':
            return 'error';
        case 'TOOL_USED':
        case 'TASK_GRAPH_UPDATED':
        case 'TASK_PLAN_CREATED':
            return 'progress';
        default:
            return 'info';
    }
}
