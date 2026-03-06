import { EventEmitter } from 'node:events';

import { type SystemEvent } from '@ai-hivemind/shared';

/**
 * EventBus — Singleton wrapping Node's native EventEmitter.
 *
 * Architecture invariants:
 *  1. LEDGER-FIRST: every event is appended to the in-memory ledger
 *     before being published to subscribers. When a persistent store is
 *     wired up (Phase 2), the append call here becomes the durable write.
 *  2. No event escapes the bus unlogged. Subscribers must never bypass emit().
 *  3. This module exports a single shared instance. Import `eventBus` — never
 *     construct a second EventBus.
 */

// Internal topic used to fan-out all events to wildcard subscribers.
const WILDCARD_TOPIC = '__all__';

class EventBus {
    readonly #emitter: EventEmitter;

    /**
     * In-memory ledger — append-only ordered sequence of all emitted events.
     * Acts as the source-of-truth until Phase 2 wires a PostgreSQL backend.
     * Read via getLedger(); never mutate directly.
     */
    readonly #ledger: SystemEvent[] = [];

    constructor() {
        this.#emitter = new EventEmitter();
        // Raise the default listener limit — the simulator + server both subscribe.
        this.#emitter.setMaxListeners(64);
    }

    /**
     * Emit a SystemEvent onto the bus.
     *
     * Ledger-first: the event is appended to #ledger synchronously before any
     * subscriber is notified. If a subscriber throws, the ledger entry is
     * already committed (consistent with the durability guarantee).
     */
    emit(event: SystemEvent): void {
        // 1. Durable write (in-memory for Phase 1; swap for DB call in Phase 2)
        this.#ledger.push(event);

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
     * Returns a shallow copy of the in-memory ledger.
     * Used by the HTTP replay endpoint to serve historical events to late-joining clients.
     */
    getLedger(): readonly SystemEvent[] {
        return [...this.#ledger];
    }

    /**
     * Returns the current ledger size — useful for health-check reporting.
     */
    get ledgerSize(): number {
        return this.#ledger.length;
    }
}

// ─── Singleton export ──────────────────────────────────────────────────────────
//
// Import this instance everywhere. Never construct a new EventBus().
// ESM module caching guarantees a single instance per process.
//
export const eventBus = new EventBus();
