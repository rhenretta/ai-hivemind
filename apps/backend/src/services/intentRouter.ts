/**
 * intentRouter.ts — LLM-Powered Intent Classification
 *
 * Classifies raw user chat messages into one of three intents:
 *   - new_feature:      No relevant existing feature → create a new one
 *   - continue_feature:  User wants to retry/continue/iterate on an existing feature
 *   - provide_input:     A feature is blocked awaiting input and the message answers it
 *
 * Uses GPT-4o-mini (tier: 'low') for fast, cheap classification.
 * Falls back to 'new_feature' if the LLM call fails or returns malformed JSON.
 */

import { type SystemEvent } from '@ai-hivemind/shared';

import { extractTextContent, generateWithRawTools } from './llm.js';
import { getEventsByType } from './ledgerStore.js';
import { logger } from './logger.js';
import { sessionStore } from './sessionStore.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FeatureSummary {
    id: string;
    title: string;
    status: string;
    lastActivity: string;
    blockedQuestion?: string | undefined;
}

export interface ChatMessageSummary {
    role: 'user' | 'system';
    text: string;
    traceId?: string | undefined;
    timestamp: string;
}

export interface IntentResult {
    intent: 'new_feature' | 'continue_feature' | 'provide_input';
    targetTraceId: string | null;
    enrichedObjective: string;
    reasoning: string;
}

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intent classifier for a software development AI system. Users submit chat messages that may be new feature requests, continuations of existing work, or answers to questions the system asked.

Classify each user message into exactly ONE intent:

1. **new_feature** — The message describes a new request unrelated to any active feature. Use this when:
   - The message is a clear new objective/feature/task
   - It doesn't reference or relate to any existing feature
   - When in doubt and no strong match exists, default to this

2. **continue_feature** — The user wants to retry, continue, iterate on, or modify an existing feature. Use this when:
   - The message says "continue", "retry", "keep going", "try again", "fix that", etc.
   - The message references an existing feature by name or description
   - The message provides additional requirements for an in-progress, failed, or completed feature
   - A vague message like "continue" with only one recently active feature clearly refers to it

3. **provide_input** — A feature is blocked waiting for user input, and the message answers that question. Use this when:
   - There is a feature with status "blocked" that has a pending question
   - The user's message plausibly answers that blocked question
   - Prefer this over continue_feature when a feature is explicitly blocked

**Tie-breaking rules:**
- If multiple features could match, prefer the most recently active one
- If a feature is "blocked" with a question and the message could be an answer, choose provide_input
- If unsure, default to new_feature (safe fallback)

Respond with ONLY a JSON object (no markdown fences):
{
  "intent": "new_feature" | "continue_feature" | "provide_input",
  "targetTraceId": "<traceId of existing feature or null for new_feature>",
  "reasoning": "<brief 1-sentence explanation>"
}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a summary of active features/sessions.
 * Reads from the persistent sessionStore. Enriches blocked sessions with the
 * pending question from the ledger (which sessionStore doesn't track).
 */
export function getFeatureSummaries(): FeatureSummary[] {
    const sessions = sessionStore.listSessions();

    // Build a map for quick lookup when enriching with blocked questions
    const summaries: FeatureSummary[] = sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        lastActivity: s.updatedAt,
    }));

    // Enrich blocked sessions with the pending question from ledger
    const inputRequired = getEventsByType('AGENT_INPUT_REQUIRED');
    for (const summary of summaries) {
        if (summary.status !== 'blocked') continue;

        // Find the most recent AGENT_INPUT_REQUIRED for this session
        const events = inputRequired.filter((e) => e.traceId === summary.id);
        const latest = events[events.length - 1];
        if (latest !== undefined) {
            summary.blockedQuestion = typeof latest.payload['question'] === 'string'
                ? latest.payload['question']
                : typeof latest.payload['text'] === 'string'
                    ? latest.payload['text']
                    : undefined;
        }
    }

    return summaries;
}

/**
 * Get recent chat messages from the ledger for conversational context.
 */
export function getRecentChatMessages(limit: number): ChatMessageSummary[] {
    const messages: ChatMessageSummary[] = [];

    // Get recent user commands
    const commands = getEventsByType('USER_COMMAND', limit);
    for (const cmd of commands) {
        const text = typeof cmd.payload['originalText'] === 'string'
            ? cmd.payload['originalText']
            : typeof cmd.payload['objective'] === 'string'
                ? cmd.payload['objective']
                : '';
        if (text !== '') {
            messages.push({
                role: 'user',
                text,
                traceId: cmd.traceId ?? undefined,
                timestamp: cmd.timestamp,
            });
        }
    }

    // Get recent system responses (task completions, errors)
    const stateChanges = getEventsByType('STATE_CHANGED', limit);
    for (const evt of stateChanges) {
        if (evt.payload['taskComplete'] === true || evt.payload['awaitingApproval'] === true) {
            const text = typeof evt.payload['message'] === 'string'
                ? evt.payload['message']
                : '';
            if (text !== '') {
                messages.push({
                    role: 'system',
                    text,
                    traceId: evt.traceId ?? undefined,
                    timestamp: evt.timestamp,
                });
            }
        }
    }

    // Sort by timestamp and take most recent
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return messages.slice(-limit);
}

// ── Main Classification ──────────────────────────────────────────────────────

/**
 * Classify a user message into an intent using GPT-4o-mini.
 * Falls back to 'new_feature' on any error.
 */
export async function classifyIntent(
    userText: string,
    features: FeatureSummary[],
    recentMessages: ChatMessageSummary[],
): Promise<IntentResult> {
    const fallback: IntentResult = {
        intent: 'new_feature',
        targetTraceId: null,
        enrichedObjective: userText,
        reasoning: 'Fallback — treated as new feature',
    };

    // Short-circuit: if no features exist, it's always a new feature
    if (features.length === 0) {
        return { ...fallback, reasoning: 'No existing features — new feature' };
    }

    // Build the user prompt with context
    const featureList = features.map((f) => {
        let line = `- [${f.id}] "${f.title}" (status: ${f.status}, last active: ${f.lastActivity})`;
        if (f.blockedQuestion !== undefined) {
            line += `\n  BLOCKED — awaiting answer to: "${f.blockedQuestion}"`;
        }
        return line;
    }).join('\n');

    const chatContext = recentMessages.map((m) => {
        const prefix = m.role === 'user' ? 'User' : 'System';
        return `[${m.timestamp}] ${prefix}: ${m.text.slice(0, 200)}`;
    }).join('\n');

    const userPrompt = `## Active Features
${featureList}

## Recent Chat History
${chatContext}

## New User Message
"${userText}"

Classify this message.`;

    try {
        const completion = await generateWithRawTools(
            [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            [],
            'low',
        );

        const raw = extractTextContent(completion).trim();
        logger.info(`[IntentRouter] Raw LLM response: ${raw}`);

        // Strip markdown fences if present
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleaned) as {
            intent?: string;
            targetTraceId?: string | null;
            reasoning?: string;
        };

        const intent = parsed.intent;
        if (intent !== 'new_feature' && intent !== 'continue_feature' && intent !== 'provide_input') {
            logger.warn(`[IntentRouter] Invalid intent "${String(intent)}", falling back to new_feature`);
            return fallback;
        }

        const targetTraceId = typeof parsed.targetTraceId === 'string' ? parsed.targetTraceId : null;
        const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

        // Validate targetTraceId exists for non-new intents
        if (intent !== 'new_feature' && targetTraceId === null) {
            logger.warn(`[IntentRouter] ${intent} without targetTraceId, falling back to new_feature`);
            return fallback;
        }

        // For continue_feature, build enriched objective with context
        let enrichedObjective = userText;
        if (intent === 'continue_feature' && targetTraceId !== null) {
            const targetFeature = features.find((f) => f.id === targetTraceId);
            if (targetFeature !== undefined) {
                // Find the original objective from the ledger
                const originalCommand = getOriginalObjective(targetTraceId);
                enrichedObjective = [
                    `Continue working on: "${targetFeature.title}"`,
                    originalCommand !== undefined ? `Original objective: ${originalCommand}` : '',
                    `Current status: ${targetFeature.status}`,
                    `User says: "${userText}"`,
                ].filter(Boolean).join('\n');
            }
        }

        const result: IntentResult = {
            intent,
            targetTraceId,
            enrichedObjective,
            reasoning,
        };

        logger.info(`[IntentRouter] Classified: intent=${intent} targetTraceId=${targetTraceId ?? 'null'} reasoning="${reasoning}"`);
        return result;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[IntentRouter] Classification failed: ${msg}`);
        return fallback;
    }
}

/**
 * Find the original objective text for a feature from its first USER_COMMAND event.
 */
function getOriginalObjective(traceId: string): string | undefined {
    const commands = getEventsByType('USER_COMMAND');
    const first = commands.find((e) => e.traceId === traceId);
    if (first === undefined) return undefined;

    return typeof first.payload['originalText'] === 'string'
        ? first.payload['originalText']
        : typeof first.payload['objective'] === 'string'
            ? first.payload['objective']
            : undefined;
}
