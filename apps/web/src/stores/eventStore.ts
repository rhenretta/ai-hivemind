import { type SystemEvent } from '@ai-hivemind/shared';
import { create } from 'zustand';

const MAX_EVENTS = parseInt(
    process.env['NEXT_PUBLIC_MAX_LEDGER_EVENTS'] ?? '2000',
    10,
);

interface EventState {
    events: SystemEvent[];

    appendEvent: (event: SystemEvent) => void;
    bulkLoad: (events: SystemEvent[]) => void;
    getEventsByTrace: (traceId: string) => SystemEvent[];
}

export const useEventStore = create<EventState>()((set, get) => ({
    events: [],

    appendEvent: (event) =>
        set((state) => {
            const events =
                state.events.length >= MAX_EVENTS
                    ? [...state.events.slice(-(MAX_EVENTS - 1)), event]
                    : [...state.events, event];
            return { events };
        }),

    bulkLoad: (incoming) =>
        set((state) => {
            const merged = [...state.events, ...incoming];
            const deduped = Array.from(
                new Map(merged.map((e) => [e.eventId, e])).values(),
            );
            return { events: deduped.slice(-MAX_EVENTS) };
        }),

    getEventsByTrace: (traceId) =>
        get().events.filter((e) => e.traceId === traceId),
}));

export const selectEvents = (s: EventState) => s.events;
export const selectEventsByTrace = (traceId: string) => (s: EventState) =>
    s.events.filter((e) => e.traceId === traceId);
