import { type SystemEvent } from '@ai-hivemind/shared';

/**
 * Translates a raw SystemEvent into a user-friendly activity summary.
 * Returns null for events that should be hidden from the activity log.
 *
 * Conductor-internal events (Claude Code tool calls, streaming) are hidden —
 * those are visible in the Terminal tab. Only agent-level actions are shown here.
 */
export function translateEvent(event: SystemEvent): string | null {
    const { eventType, payload, sourceId } = event;

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
            if (payload['passed'] === true) return 'QA passed';
            if (payload['passed'] === false) return 'QA failed — retrying';

            // Test plan updates from QA agent
            const testPlan = payload['testPlan'] as { tests: { status: string }[] } | undefined;
            if (testPlan !== undefined) {
                const total = testPlan.tests.length;
                const passed = testPlan.tests.filter((t) => t.status === 'passed').length;
                const failed = testPlan.tests.filter((t) => t.status === 'failed').length;
                return `QA testing: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`;
            }

            const message = typeof payload['message'] === 'string' ? payload['message'] : null;
            const phase = typeof payload['phase'] === 'string' ? payload['phase'] : null;

            // Hide PM orchestration phases — redundant with child agent rows
            // (Data Researcher, UX Designer, SWE appear as their own rows)
            if (typeof sourceId === 'string' && sourceId.startsWith('project-manager')) {
                const hiddenPhases = new Set(['start', 'research', 'design', 'decompose', 'propose', 'explore']);
                if (phase !== null && hiddenPhases.has(phase)) {
                    return null;
                }
            }

            if (message !== null && phase !== null) {
                return message;
            }
            return null;
        }

        case 'TOOL_USED': {
            const source = typeof payload['source'] === 'string' ? payload['source'] : '';

            // Hide Claude Code internal tool calls — visible in Terminal tab
            if (source.startsWith('conductor:')) return null;

            // Show agent-level tool calls (QA probes, coordinator tools, researcher queries)
            const toolName = typeof payload['toolName'] === 'string' ? payload['toolName'] : '';
            const phase = typeof payload['phase'] === 'string' ? payload['phase'] : '';

            if (phase === 'qa') {
                // QA agent tool calls
                if (toolName === 'http_get') {
                    const input = payload['input'] as Record<string, unknown> | undefined;
                    const url = typeof input?.['url'] === 'string' ? input['url'] : '';
                    if (input?.['blocked'] === true) return `QA blocked: ${url} (port not mapped)`;
                    return url !== '' ? `QA probing: ${url}` : 'QA running HTTP check';
                }
                if (toolName === 'execute_cli_command') {
                    const input = payload['input'] as Record<string, unknown> | undefined;
                    const cmd = typeof input?.['command'] === 'string' ? input['command'] : '';
                    // Shorten docker exec prefix for readability
                    const shortCmd = cmd.replace(/^docker exec \S+ sh -c /, '');
                    return `QA running: ${shortCmd}`;
                }
                if (toolName === 'screenshot_url') return 'QA taking screenshot';
                if (toolName === 'browser_navigate') {
                    const navInput = payload['input'] as Record<string, unknown> | undefined;
                    const navUrl = typeof navInput?.['url'] === 'string' ? navInput['url'] : '';
                    return navUrl !== '' ? `QA navigating to: ${navUrl}` : 'QA navigating browser';
                }
                if (toolName === 'browser_screenshot') return 'QA taking screenshot';
                if (toolName === 'browser_click') {
                    const clickInput = payload['input'] as Record<string, unknown> | undefined;
                    const clickSel = typeof clickInput?.['selector'] === 'string' ? clickInput['selector'] : '';
                    return `QA clicking: ${clickSel}`;
                }
                if (toolName === 'browser_fill') {
                    const fillInput = payload['input'] as Record<string, unknown> | undefined;
                    const fillSel = typeof fillInput?.['selector'] === 'string' ? fillInput['selector'] : '';
                    return `QA filling form: ${fillSel}`;
                }
                if (toolName === 'browser_wait_for') {
                    const waitInput = payload['input'] as Record<string, unknown> | undefined;
                    const waitSel = typeof waitInput?.['selector'] === 'string' ? waitInput['selector'] : '';
                    const waitState = typeof waitInput?.['state'] === 'string' ? waitInput['state'] : 'visible';
                    return `QA waiting for: ${waitSel} (${waitState})`;
                }
                if (toolName === 'browser_get_text') return 'QA reading page text';
                if (toolName === 'browser_evaluate') return 'QA running page script';
                if (toolName === 'update_test_plan') return 'QA updating test plan';
                if (toolName === 'submit_qa_verdict') return 'QA submitting verdict';
                return `QA: ${toolName}`;
            }

            if (phase === 'explore') {
                // Site Explorer agent tool calls
                if (toolName === 'browser_navigate') {
                    const navInput = payload['input'] as Record<string, unknown> | undefined;
                    const navUrl = typeof navInput?.['url'] === 'string' ? navInput['url'] : '';
                    return navUrl !== '' ? `Exploring: ${navUrl}` : 'Exploring site';
                }
                if (toolName === 'browser_screenshot') return 'Capturing page screenshot';
                if (toolName === 'browser_get_text') return 'Reading page content';
                if (toolName === 'browser_evaluate') return 'Analyzing page structure';
                if (toolName === 'browser_click') {
                    const clickInput = payload['input'] as Record<string, unknown> | undefined;
                    const clickSel = typeof clickInput?.['selector'] === 'string' ? clickInput['selector'] : '';
                    return clickSel !== '' ? `Exploring link: ${clickSel}` : 'Exploring navigation';
                }
                if (toolName === 'submit_exploration') return 'Cataloging site structure';
                return `Exploring: ${toolName}`;
            }

            if (phase === 'design') {
                // UX Designer ask_engineer tool calls
                if (toolName === 'ask_engineer') {
                    const aeInput = payload['input'] as Record<string, unknown> | undefined;
                    const question = typeof aeInput?.['question'] === 'string' ? aeInput['question'].slice(0, 80) : '';
                    return question !== '' ? `Asking about codebase: ${question}` : 'Asking about codebase';
                }
            }

            // Other agent tool calls (coordinator, data researcher)
            if (toolName === 'decompose_task') return 'Decomposing task into steps';
            if (toolName === 'web_search' || toolName === 'query_rag') return `Researching: ${toolName}`;
            return `${sourceId}: ${toolName}`;
        }

        case 'AGENT_SPAWNED': {
            const role = typeof payload['role'] === 'string' ? payload['role'] : sourceId;
            return `Agent started: ${role}`;
        }

        case 'AGENT_TERMINATED': {
            const reason = typeof payload['reason'] === 'string' ? payload['reason'] : '';
            return reason !== '' ? `Agent finished: ${reason}` : 'Agent finished';
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

        case 'QA_ARBITER_DECISION': {
            const decision = payload['decision'] as string | undefined;
            if (decision === 'retry') return 'Reviewing QA results, retrying...';
            if (decision === 'ask_user') {
                const q = typeof payload['userQuestion'] === 'string'
                    ? payload['userQuestion']
                    : 'Needs clarification';
                return `QA needs your input: ${q}`;
            }
            if (decision === 'accept') return 'QA issues reviewed — accepting implementation';
            return 'QA arbiter made a decision';
        }

        // Hidden events — return null
        case 'MESSAGE_SENT':
        case 'CONDUCTOR_STREAM':
        case 'TOOL_REGISTERED':
        case 'MEMORY_STORED':
        case 'MEMORY_DELETED':
        case 'RAG_STORE_CREATED':
        case 'CREDENTIAL_STORED':
        case 'CREDENTIAL_DELETED':
        case 'SANDBOX_LOG':
        case 'SESSION_CREATED':
        case 'SESSION_UPDATED':
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
        case 'QA_ARBITER_DECISION':
            return event.payload['decision'] === 'ask_user' ? 'question' : 'info';
        case 'ERROR':
            return 'error';
        case 'TOOL_USED':
        case 'TASK_GRAPH_UPDATED':
        case 'TASK_PLAN_CREATED':
        case 'AGENT_SPAWNED':
            return 'progress';
        case 'AGENT_TERMINATED':
            return 'info';
        default:
            return 'info';
    }
}
