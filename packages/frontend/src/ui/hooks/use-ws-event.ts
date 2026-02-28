// packages/frontend/src/ui/hooks/use-ws-event.ts

import { useEffect } from 'react';
import { wsEventBus } from '../../mw/ws/ws-event-bus.js';

export function useWsEvent<T = unknown>(
  eventType: string,
  handler:   (payload: T) => void,
): void {
  useEffect(() => {
    const cb = (payload: T) => handler(payload);
    wsEventBus.on(eventType, cb);
    return () => {
      wsEventBus.off(eventType, cb);
    };
  }, [eventType, handler]);
}
