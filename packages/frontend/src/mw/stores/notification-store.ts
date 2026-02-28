// packages/frontend/src/mw/stores/notification-store.ts

import { create } from 'zustand';

export interface Notification {
  id:        string;
  severity:  'info' | 'warning' | 'error';
  message:   string;
  timestamp: number;
  read:      boolean;
}

export interface NotificationStoreState {
  notifications: Notification[];
  unreadCount:   number;

  push(n: Omit<Notification, 'id' | 'read'>): void;
  markAllRead(): void;
  dismiss(id: string): void;
}

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  notifications: [],
  unreadCount:   0,

  push(n) {
    const item: Notification = {
      ...n,
      id:   crypto.randomUUID(),
      read: false,
    };
    set(s => ({
      notifications: [item, ...s.notifications].slice(0, 100),
      unreadCount:   s.unreadCount + 1,
    }));
  },

  markAllRead() {
    set(s => ({
      notifications: s.notifications.map(n => ({ ...n, read: true })),
      unreadCount:   0,
    }));
  },

  dismiss(id) {
    set(s => {
      const next = s.notifications.filter(n => n.id !== id);
      return {
        notifications: next,
        unreadCount:   next.filter(n => !n.read).length,
      };
    });
  },
}));
