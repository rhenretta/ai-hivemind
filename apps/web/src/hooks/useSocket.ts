'use client';

/**
 * useSocket — Socket.io connection singleton and event router
 *
 * Replaces the old useSwarmSocket hook. Routes WebSocket events to the
 * new decomposed stores (connectionStore, chatStore, featureStore, etc.)
 * instead of the monolithic swarmStore.
 *
 * Architecture rules (carried forward):
 *  1. Socket is MODULE-LEVEL singleton. Created once, reused forever.
 *  2. This hook is called ONCE from SocketProvider at the app root.
 *  3. Named handler refs for StrictMode safety.
 */

// socket.io-client Manager type is loosely typed for reconnect events.
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { type SystemEvent } from '@ai-hivemind/shared';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { v4 as uuid } from 'uuid';

import { useChatStore } from '@/stores/chatStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useEventStore } from '@/stores/eventStore';
import { useFeatureStore } from '@/stores/featureStore';
import { useNotificationStore } from '@/stores/notificationStore';

const NERVE_CENTER_URL =
    process.env['NEXT_PUBLIC_NERVE_CENTER_URL'] ?? 'http://localhost:3001';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let socket: ReturnType<typeof io> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSocket(): ReturnType<typeof io> {
    if (socket === null) {
        socket = io(NERVE_CENTER_URL, {
            reconnectionAttempts: 20,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30_000,
            transports: ['websocket', 'polling'],
        });
    }
    return socket;
}

/**
 * Route a single SystemEvent to the appropriate stores.
 */
function routeEvent(event: SystemEvent): void {
    const { appendEvent } = useEventStore.getState();
    const chatStore = useChatStore.getState();
    const featureStore = useFeatureStore.getState();
    const notificationStore = useNotificationStore.getState();

    // Always store raw event
    appendEvent(event);

    const traceId = event.traceId;
    if (traceId === undefined || traceId === '') return;

    switch (event.eventType) {
        case 'USER_COMMAND': {
            const existing = featureStore.features[traceId];

            // Reconstruct user chat message from the ledger event
            // (ChatInput adds these optimistically, but they're lost on page reload)
            // Skip when sourceId is 'dialogue-agent' — these are internal work triggers,
            // not actual user messages.
            if (event.sourceId !== 'dialogue-agent') {
                const userText = typeof event.payload['originalText'] === 'string'
                    ? event.payload['originalText']
                    : typeof event.payload['objective'] === 'string'
                        ? event.payload['objective']
                        : null;
                if (userText !== null) {
                    chatStore.appendMessage({
                        id: event.eventId,
                        role: 'user',
                        text: userText,
                        timestamp: event.timestamp,
                        traceId,
                        type: 'text',
                    });
                }
            }

            if (event.sourceId === 'dialogue-agent' && existing !== undefined) {
                // Work trigger from dialogue agent — update status to in_progress
                featureStore.updateFeatureStatus(traceId, 'in_progress');
            } else if (existing === undefined) {
                // New feature — use originalText (if available) for a clean title
                const title = typeof event.payload['originalText'] === 'string'
                    ? event.payload['originalText']
                    : typeof event.payload['objective'] === 'string'
                        ? event.payload['objective']
                        : 'New feature';
                featureStore.upsertFeature({
                    id: traceId,
                    title,
                    description: '',
                    status: 'in_progress',
                    createdAt: event.timestamp,
                    updatedAt: event.timestamp,
                    stepsTotal: 0,
                    stepsComplete: 0,
                });
            }
            break;
        }

        case 'STATE_CHANGED': {
            if (event.payload['awaitingApproval'] === true) {
                // Update feature card status only — no chat message
                // (the DialogueAgent handles conversation, not proposals)
                featureStore.updateFeatureStatus(traceId, 'proposal');
                chatStore.setAiTyping(false);
            } else if (event.payload['taskComplete'] === true) {
                const message = typeof event.payload['message'] === 'string'
                    ? event.payload['message']
                    : 'This feature is complete!';
                chatStore.appendMessage({
                    id: uuid(),
                    role: 'ai',
                    text: message,
                    timestamp: event.timestamp,
                    traceId,
                    type: 'text',
                });
                featureStore.updateFeatureStatus(traceId, 'completed');
                chatStore.setAiTyping(false);

                const feature = featureStore.features[traceId];
                notificationStore.addNotification({
                    id: uuid(),
                    featureId: traceId,
                    featureTitle: feature?.title ?? 'Feature',
                    type: 'ready',
                    message: 'Ready to check out!',
                    timestamp: event.timestamp,
                    read: false,
                });
            }
            break;
        }

        case 'TASK_GRAPH_UPDATED': {
            const graph = event.payload['graph'] as {
                nodes?: { status: string; objective?: string }[];
            } | undefined;

            if (graph?.nodes !== undefined) {
                const done = graph.nodes.filter((n) => n.status === 'done').length;
                const total = graph.nodes.length;
                const active = graph.nodes.find((n) => n.status === 'active');
                featureStore.updateFeatureProgress(
                    traceId,
                    done,
                    total,
                    typeof active?.objective === 'string' ? active.objective : undefined,
                );
                featureStore.updateFeatureStatus(traceId, 'in_progress');
            }
            break;
        }

        case 'TASK_NODE_COMPLETED': {
            const status = event.payload['status'] as string | undefined;
            if (status === 'failed') {
                const feature = featureStore.features[traceId];
                notificationStore.addNotification({
                    id: uuid(),
                    featureId: traceId,
                    featureTitle: feature?.title ?? 'Feature',
                    type: 'failed',
                    message: 'A step ran into a problem',
                    timestamp: event.timestamp,
                    read: false,
                });
            }
            break;
        }

        case 'QA_VERDICT': {
            if (event.payload['passed'] !== true) {
                featureStore.updateFeatureStatus(traceId, 'qa_in_progress');
            }
            break;
        }

        case 'AGENT_INPUT_REQUIRED': {
            const question = typeof event.payload['question'] === 'string'
                ? event.payload['question']
                : typeof event.payload['text'] === 'string'
                    ? event.payload['text']
                    : 'The AI has a question for you';

            featureStore.setFeatureNeedsInput(traceId, question, event.eventId);

            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: question,
                timestamp: event.timestamp,
                traceId,
                type: 'clarification',
                clarification: { question, responded: false },
            });

            const feature = featureStore.features[traceId];
            notificationStore.addNotification({
                id: uuid(),
                featureId: traceId,
                featureTitle: feature?.title ?? 'Feature',
                type: 'needs_input',
                message: question,
                timestamp: event.timestamp,
                read: false,
            });

            chatStore.setAiTyping(false);
            break;
        }

        case 'SERVICE_DEPLOYED': {
            const url = typeof event.payload['url'] === 'string' ? event.payload['url'] : '';
            if (url !== '') {
                featureStore.setFeaturePreview(traceId, url);
                chatStore.appendMessage({
                    id: uuid(),
                    role: 'ai',
                    text: 'Your feature has a preview ready!',
                    timestamp: event.timestamp,
                    traceId,
                    type: 'preview',
                    previewUrl: url,
                });
            }
            break;
        }

        case 'FEATURE_DEPLOYED': {
            const routes = Array.isArray(event.payload['routes']) ? event.payload['routes'] as string[] : [];
            const route = routes[0];
            featureStore.setFeatureDeployed(traceId, route);

            const feature = featureStore.features[traceId];
            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: route !== undefined ? `Feature deployed at ${route}!` : 'Feature deployed!',
                timestamp: event.timestamp,
                traceId,
                type: 'text',
            });
            notificationStore.addNotification({
                id: uuid(),
                featureId: traceId,
                featureTitle: feature?.title ?? 'Feature',
                type: 'ready',
                message: 'Feature is now live!',
                timestamp: event.timestamp,
                read: false,
            });
            break;
        }

        case 'USER_INTERVENTION': {
            // Reconstruct user intervention messages (approval, clarification responses)
            const interventionText = typeof event.payload['text'] === 'string'
                ? event.payload['text']
                : null;
            if (interventionText !== null) {
                chatStore.appendMessage({
                    id: event.eventId,
                    role: 'user',
                    text: interventionText,
                    timestamp: event.timestamp,
                    traceId,
                    type: 'text',
                });
            }
            break;
        }

        case 'DIALOGUE_RESPONSE': {
            const dialogueText = typeof event.payload['text'] === 'string'
                ? event.payload['text']
                : 'The AI responded';

            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: dialogueText,
                timestamp: event.timestamp,
                traceId,
                type: 'dialogue',
            });
            chatStore.setAiTyping(false);

            // During the exploring phase (before work starts), show "Thinking About It"
            // instead of "Building" on the feature card
            const phase = typeof event.payload['conversationPhase'] === 'string'
                ? event.payload['conversationPhase']
                : 'exploring';
            if (phase === 'exploring') {
                featureStore.updateFeatureStatus(traceId, 'proposal');
            }
            break;
        }

        case 'FEATURE_DELETED': {
            featureStore.deleteFeature(traceId);
            break;
        }

        case 'ERROR': {
            // Update feature card status only — no chat message
            // (user only wants to know when features are ready)
            featureStore.updateFeatureStatus(traceId, 'failed');
            chatStore.setAiTyping(false);
            break;
        }

        // These events are stored in eventStore but not surfaced in chat
        default:
            break;
    }
}

/**
 * Initialize the WebSocket connection and wire events to stores.
 * Call exactly once from SocketProvider.
 */
export function useSocket(): void {
    useEffect(() => {
        const ws = getSocket();

        const { setStatus } = useConnectionStore.getState();
        const { bulkLoad } = useEventStore.getState();

        const onConnect = (): void => { setStatus('connected'); };
        const onDisconnect = (): void => { setStatus('disconnected'); };
        const onReconnectAttempt = (): void => { setStatus('reconnecting'); };
        const onReconnect = (): void => { setStatus('connected'); };
        const onReconnectFailed = (): void => { setStatus('disconnected'); };
        const onSystemEvent = (event: SystemEvent): void => { routeEvent(event); };
        const onSystemReplay = (events: SystemEvent[]): void => {
            bulkLoad(events);
            // Clear chat messages before replay — they'll be reconstructed by routeEvent
            // This prevents duplicates on reconnect (where old in-memory messages
            // would overlap with replayed events).
            useChatStore.getState().loadHistory([]);
            // Replay events through router for store hydration
            for (const event of events) {
                routeEvent(event);
            }
        };
        const onIntentResolved = (data: {
            clientEventId: string;
            traceId: string;
            intent: string;
            reasoning: string;
        }): void => {
            const chatState = useChatStore.getState();
            const featureState = useFeatureStore.getState();

            // Link the optimistic chat message to the resolved traceId
            chatState.updateMessage(data.clientEventId, { traceId: data.traceId });

            if (data.intent === 'new_feature') {
                // Create feature entry (continue/provide_input features already exist)
                const msg = chatState.messages.find((m) => m.id === data.clientEventId);
                featureState.upsertFeature({
                    id: data.traceId,
                    title: msg?.text ?? 'New feature',
                    description: '',
                    status: 'in_progress',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    stepsTotal: 0,
                    stepsComplete: 0,
                });
            }
            // No acknowledgment message for continue/provide_input —
            // the DialogueAgent's DIALOGUE_RESPONSE handles conversation
        };

        ws.on('connect', onConnect);
        ws.on('disconnect', onDisconnect);
        ws.io.on('reconnect_attempt', onReconnectAttempt);
        ws.io.on('reconnect', onReconnect);
        ws.io.on('reconnect_failed', onReconnectFailed);
        ws.on('system:event', onSystemEvent);
        ws.on('system:replay', onSystemReplay);
        ws.on('intent:resolved', onIntentResolved);

        if (ws.connected) {
            setStatus('connected');
        }

        return () => {
            ws.off('connect', onConnect);
            ws.off('disconnect', onDisconnect);
            ws.io.off('reconnect_attempt', onReconnectAttempt);
            ws.io.off('reconnect', onReconnect);
            ws.io.off('reconnect_failed', onReconnectFailed);
            ws.off('system:event', onSystemEvent);
            ws.off('system:replay', onSystemReplay);
            ws.off('intent:resolved', onIntentResolved);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
