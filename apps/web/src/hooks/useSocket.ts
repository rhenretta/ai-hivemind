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
            // Create feature entry
            const objective = typeof event.payload['objective'] === 'string'
                ? event.payload['objective']
                : 'New feature';
            featureStore.upsertFeature({
                id: traceId,
                title: objective,
                description: '',
                status: 'in_progress',
                createdAt: event.timestamp,
                updatedAt: event.timestamp,
                stepsTotal: 0,
                stepsComplete: 0,
            });
            break;
        }

        case 'STATE_CHANGED': {
            if (event.payload['awaitingApproval'] === true) {
                const proposal = event.payload['proposal'] as {
                    title?: string;
                    description?: string;
                    steps?: string[];
                } | undefined;

                chatStore.appendMessage({
                    id: uuid(),
                    role: 'ai',
                    text: typeof event.payload['message'] === 'string'
                        ? event.payload['message']
                        : 'I have a plan for this feature.',
                    timestamp: event.timestamp,
                    traceId,
                    type: 'proposal',
                    proposal: {
                        title: proposal?.title ?? 'New Feature',
                        description: proposal?.description ?? '',
                        steps: proposal?.steps ?? [],
                        status: 'proposed',
                    },
                });
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

        case 'ERROR': {
            const message = typeof event.payload['message'] === 'string'
                ? event.payload['message']
                : 'Something went wrong';
            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: `Something went wrong: ${message}`,
                timestamp: event.timestamp,
                traceId,
                type: 'text',
            });
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
            // Replay events through router for store hydration
            for (const event of events) {
                routeEvent(event);
            }
        };

        ws.on('connect', onConnect);
        ws.on('disconnect', onDisconnect);
        ws.io.on('reconnect_attempt', onReconnectAttempt);
        ws.io.on('reconnect', onReconnect);
        ws.io.on('reconnect_failed', onReconnectFailed);
        ws.on('system:event', onSystemEvent);
        ws.on('system:replay', onSystemReplay);

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
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
