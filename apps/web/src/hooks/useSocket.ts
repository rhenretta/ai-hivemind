'use client';

/**
 * useSocket — Socket.io connection singleton and event router
 *
 * Routes WebSocket events to the decomposed stores (connectionStore,
 * chatStore, sessionStore, etc.)
 *
 * Architecture rules:
 *  1. Socket is MODULE-LEVEL singleton. Created once, reused forever.
 *  2. This hook is called ONCE from SocketProvider at the app root.
 *  3. Named handler refs for StrictMode safety.
 */

// socket.io-client Manager type is loosely typed for reconnect events.
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { type SystemEvent, type Session } from '@ai-hivemind/shared';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { v4 as uuid } from 'uuid';

import { useChatStore } from '@/stores/chatStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useEventStore } from '@/stores/eventStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useSessionStore } from '@/stores/sessionStore';

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
    const sessionStore = useSessionStore.getState();
    const notificationStore = useNotificationStore.getState();

    // Always store raw event
    appendEvent(event);

    const traceId = event.traceId;
    if (traceId === undefined || traceId === '') return;

    switch (event.eventType) {
        case 'USER_COMMAND': {
            // Reconstruct user chat message from the ledger event
            // Skip when sourceId is 'dialogue-agent' — internal work triggers
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

            // Session creation is handled by SESSION_CREATED events.
            // Just update status for work triggers from dialogue agent.
            if (event.sourceId === 'dialogue-agent') {
                const existing = sessionStore.sessions[traceId];
                if (existing !== undefined) {
                    sessionStore.updateSessionStatus(traceId, 'active');
                }
            }
            break;
        }

        case 'SESSION_CREATED': {
            const session = event.payload as unknown as Session;
            sessionStore.upsertSession(session);
            break;
        }

        case 'SESSION_UPDATED': {
            const payload = event.payload;
            const id = typeof payload['id'] === 'string' ? payload['id'] : traceId;
            const existing = sessionStore.sessions[id];
            if (existing !== undefined) {
                const patch: Partial<Session> = {};
                if (typeof payload['title'] === 'string') patch.title = payload['title'];
                if (typeof payload['status'] === 'string') patch.status = payload['status'] as Session['status'];
                if (typeof payload['updatedAt'] === 'string') patch.updatedAt = payload['updatedAt'];
                sessionStore.upsertSession({ ...existing, ...patch });
            }
            break;
        }

        case 'STATE_CHANGED': {
            if (event.payload['awaitingApproval'] === true) {
                sessionStore.updateSessionStatus(traceId, 'planning');
                chatStore.setAiTyping(false);
            } else if (event.payload['taskComplete'] === true) {
                sessionStore.updateSessionStatus(traceId, 'completed');
                chatStore.setAiTyping(false);

                const session = sessionStore.sessions[traceId];
                if (session?.previewUrl !== undefined) {
                    chatStore.appendMessage({
                        id: uuid(),
                        role: 'ai',
                        text: 'Your feature is ready to test!',
                        timestamp: event.timestamp,
                        traceId,
                        type: 'preview',
                        previewUrl: session.previewUrl,
                    });
                }

                notificationStore.addNotification({
                    id: uuid(),
                    featureId: traceId,
                    featureTitle: session?.title ?? 'Session',
                    type: 'ready',
                    message: 'Ready to check out!',
                    timestamp: event.timestamp,
                    read: false,
                });
            }
            break;
        }

        case 'TASK_GRAPH_UPDATED': {
            if (event.payload['isRootGraph'] === false) break;

            interface GraphNode { status: string; objective?: string; subGraph?: { nodes: GraphNode[] } }
            const graph = event.payload['graph'] as {
                nodes?: GraphNode[];
            } | undefined;

            if (graph?.nodes !== undefined) {
                const countLeaves = (nodes: GraphNode[]): { total: number; done: number } => {
                    let total = 0;
                    let done = 0;
                    for (const n of nodes) {
                        if (n.subGraph?.nodes !== undefined && n.subGraph.nodes.length > 0) {
                            const sub = countLeaves(n.subGraph.nodes);
                            total += sub.total;
                            done += sub.done;
                        } else {
                            total++;
                            if (n.status === 'done') done++;
                        }
                    }
                    return { total, done };
                };

                const findActiveLeaf = (nodes: GraphNode[]): GraphNode | undefined => {
                    for (const n of nodes) {
                        if (n.subGraph?.nodes !== undefined && n.subGraph.nodes.length > 0) {
                            const active = findActiveLeaf(n.subGraph.nodes);
                            if (active !== undefined) return active;
                        } else if (n.status === 'active') {
                            return n;
                        }
                    }
                    return undefined;
                };

                const { total, done } = countLeaves(graph.nodes);
                const active = findActiveLeaf(graph.nodes);
                sessionStore.updateSessionProgress(
                    traceId,
                    done,
                    total,
                    typeof active?.objective === 'string' ? active.objective : undefined,
                );
                sessionStore.updateSessionStatus(traceId, 'active');
            }
            break;
        }

        case 'TASK_NODE_COMPLETED': {
            const status = event.payload['status'] as string | undefined;
            if (status === 'failed') {
                const session = sessionStore.sessions[traceId];
                notificationStore.addNotification({
                    id: uuid(),
                    featureId: traceId,
                    featureTitle: session?.title ?? 'Session',
                    type: 'failed',
                    message: 'A step ran into a problem',
                    timestamp: event.timestamp,
                    read: false,
                });
            }
            break;
        }

        case 'QA_VERDICT': {
            // QA events — no session status change needed
            break;
        }

        case 'AGENT_INPUT_REQUIRED': {
            const question = typeof event.payload['question'] === 'string'
                ? event.payload['question']
                : typeof event.payload['text'] === 'string'
                    ? event.payload['text']
                    : 'The AI has a question for you';

            sessionStore.setSessionNeedsInput(traceId, question, event.eventId);

            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: question,
                timestamp: event.timestamp,
                traceId,
                type: 'clarification',
                clarification: { question, responded: false },
            });

            const session = sessionStore.sessions[traceId];
            notificationStore.addNotification({
                id: uuid(),
                featureId: traceId,
                featureTitle: session?.title ?? 'Session',
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
                sessionStore.setSessionPreview(traceId, url);
            }
            break;
        }

        case 'FEATURE_DEPLOYED': {
            const routes = Array.isArray(event.payload['routes']) ? event.payload['routes'] as string[] : [];
            const route = routes[0];
            sessionStore.updateSessionStatus(traceId, 'completed');

            const session = sessionStore.sessions[traceId];
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
                featureTitle: session?.title ?? 'Session',
                type: 'ready',
                message: 'Feature is now live!',
                timestamp: event.timestamp,
                read: false,
            });
            break;
        }

        case 'USER_INTERVENTION': {
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

            const contextSources = Array.isArray(event.payload['contextSources'])
                ? event.payload['contextSources'] as { tool: string; summary: string }[]
                : undefined;

            chatStore.appendMessage({
                id: uuid(),
                role: 'ai',
                text: dialogueText,
                timestamp: event.timestamp,
                traceId,
                type: 'dialogue',
                ...(contextSources !== undefined && contextSources.length > 0
                    ? { contextSources }
                    : {}),
            });
            chatStore.setAiTyping(false);

            const phase = typeof event.payload['conversationPhase'] === 'string'
                ? event.payload['conversationPhase']
                : 'exploring';
            if (phase === 'exploring') {
                sessionStore.updateSessionStatus(traceId, 'exploring');
            }
            break;
        }

        case 'FEATURE_DELETED': {
            sessionStore.deleteSession(traceId);
            break;
        }

        case 'ERROR': {
            sessionStore.updateSessionStatus(traceId, 'failed');
            chatStore.setAiTyping(false);
            break;
        }

        default:
            break;
    }
}

/**
 * Fetch sessions from the REST API to hydrate the store.
 */
async function fetchSessions(): Promise<void> {
    try {
        const res = await fetch(`${NERVE_CENTER_URL}/api/sessions`);
        if (res.ok) {
            const sessions = await res.json() as Session[];
            useSessionStore.getState().hydrateSessions(sessions);
        }
    } catch {
        // Non-fatal — sessions will be populated via real-time events
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

        // Hydrate sessions from REST API
        void fetchSessions();

        const onConnect = (): void => { setStatus('connected'); };
        const onDisconnect = (): void => { setStatus('disconnected'); };
        const onReconnectAttempt = (): void => { setStatus('reconnecting'); };
        const onReconnect = (): void => {
            setStatus('connected');
            void fetchSessions();
        };
        const onReconnectFailed = (): void => { setStatus('disconnected'); };
        const onSystemEvent = (event: SystemEvent): void => { routeEvent(event); };
        const onSystemReplay = (events: SystemEvent[]): void => {
            bulkLoad(events);
            useChatStore.getState().clearAllMessages();
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
            const sessionState = useSessionStore.getState();

            // Link the optimistic chat message to the resolved traceId
            chatState.updateMessage(data.clientEventId, { traceId: data.traceId });

            if (data.intent === 'new_feature') {
                // Auto-select the new session
                sessionState.setActiveSession(data.traceId);
            }
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
