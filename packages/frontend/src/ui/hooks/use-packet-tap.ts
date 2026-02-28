// packages/frontend/src/ui/hooks/use-packet-tap.ts

import { useEffect } from 'react';
import { wsEventBus } from '../../mw/ws/ws-event-bus.js';
import { wsClient } from '../../mw/ws/ws-client.js';
import { parseBinaryFrame } from '../../mw/protocol/binary-frame.js';
import type { ParsedBinaryFrame } from '../../mw/protocol/binary-frame.js';

export type { ParsedBinaryFrame };

export function usePacketTap(
  deviceId: string,
  onFrame:  (frame: ParsedBinaryFrame) => void,
): void {
  useEffect(() => {
    wsClient.send('packettap:subscribe', { deviceId });

    const handler = (ab: ArrayBuffer) => {
      const frame = parseBinaryFrame(ab);
      if (!frame) return;
      if (frame.deviceId !== deviceId) return;
      onFrame(frame);
    };

    wsEventBus.on('ws:binary', handler);
    return () => {
      wsEventBus.off('ws:binary', handler);
      wsClient.send('packettap:unsubscribe', { deviceId });
    };
  }, [deviceId, onFrame]);
}
