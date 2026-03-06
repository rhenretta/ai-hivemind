import { create } from 'zustand';

export interface Notification {
    id: string;
    featureId: string;
    featureTitle: string;
    type: 'needs_input' | 'ready' | 'failed';
    message: string;
    timestamp: string;
    read: boolean;
}

interface NotificationState {
    notifications: Notification[];
    unreadCount: number;

    addNotification: (n: Notification) => void;
    markRead: (id: string) => void;
    markAllRead: () => void;
    dismiss: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>()((set) => ({
    notifications: [],
    unreadCount: 0,

    addNotification: (n) =>
        set((state) => ({
            notifications: [n, ...state.notifications],
            unreadCount: state.unreadCount + (n.read ? 0 : 1),
        })),

    markRead: (id) =>
        set((state) => {
            let delta = 0;
            const notifications = state.notifications.map((n) => {
                if (n.id === id && !n.read) {
                    delta = -1;
                    return { ...n, read: true };
                }
                return n;
            });
            return { notifications, unreadCount: Math.max(0, state.unreadCount + delta) };
        }),

    markAllRead: () =>
        set((state) => ({
            notifications: state.notifications.map((n) => ({ ...n, read: true })),
            unreadCount: 0,
        })),

    dismiss: (id) =>
        set((state) => {
            const target = state.notifications.find((n) => n.id === id);
            return {
                notifications: state.notifications.filter((n) => n.id !== id),
                unreadCount: Math.max(0, state.unreadCount - (target !== undefined && !target.read ? 1 : 0)),
            };
        }),
}));

export const selectNotifications = (s: NotificationState) => s.notifications;
export const selectUnreadCount = (s: NotificationState) => s.unreadCount;
