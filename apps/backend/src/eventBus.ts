import { EventEmitter } from 'node:events';

import { type SystemEvent } from '@ai-hivemind/shared';

import { appendEvent, getAllEvents, getLedgerSize } from './services/ledgerStore.js';

/**
 * EventBus — Singleton wrapping Node's native EventEmitter.
 *
 * Architecture invariants:
 *  1. LEDGER-FIRST: every event is written to the durable SQLite ledger
 *     before being published to subscribers.
 *  2. No event escapes the bus unlogged. Subscribers must never bypass emit().
 *  3. This module exports a single shared instance. Import `eventBus` — never
 *     construct a second EventBus.
 */

// Internal topic used to fan-out all events to wildcard subscribers.
const WILDCARD_TOPIC = '__all__';

class EventBus {
    readonly #emitter: EventEmitter;

    constructor() {
        this.#emitter = new EventEmitter();
        // Raise the default listener limit — the simulator + server both subscribe.
        this.#emitter.setMaxListeners(64);
    }

    /**
     * Emit a SystemEvent onto the bus.
     *
     * Ledger-first: the event is written to SQLite synchronously before any
     * subscriber is notified. If a subscriber throws, the ledger entry is
     * already committed (consistent with the durability guarantee).
     */
    emit(event: SystemEvent): void {
        // 1. Durable write to SQLite
        appendEvent(event);

        // 2. Publish to type-specific topic
        this.#emitter.emit(event.eventType, event);

        // 3. Publish to wildcard topic (used by the WebSocket bridge)
        this.#emitter.emit(WILDCARD_TOPIC, event);
    }

    /**
     * Subscribe to a specific event type.
     * Returns an unsubscribe function for clean teardown.
     */
    subscribe(
        eventType: SystemEvent['eventType'],
        handler: (event: SystemEvent) => void,
    ): () => void {
        this.#emitter.on(eventType, handler);
        return () => {
            this.#emitter.off(eventType, handler);
        };
    }

    /**
     * Subscribe to ALL event types (wildcard subscription).
     * The WebSocket bridge uses this to fan-out every event to connected clients.
     * Returns an unsubscribe function.
     */
    subscribeAll(handler: (event: SystemEvent) => void): () => void {
        this.#emitter.on(WILDCARD_TOPIC, handler);
        return () => {
            this.#emitter.off(WILDCARD_TOPIC, handler);
        };
    }

    /**
     * Returns all events from the durable SQLite ledger.
     * Used by the HTTP replay endpoint and WebSocket system:replay.
     */
    getLedger(): readonly SystemEvent[] {
        return getAllEvents();
    }

    /**
     * Returns the current ledger size — useful for health-check reporting.
     */
    get ledgerSize(): number {
        return getLedgerSize();
    }
}

// ─── Singleton export ──────────────────────────────────────────────────────────
//
// Import this instance everywhere. Never construct a new EventBus().
// ESM module caching guarantees a single instance per process.
//
export const eventBus = new EventBus();
