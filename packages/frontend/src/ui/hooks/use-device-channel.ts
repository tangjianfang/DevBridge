// packages/frontend/src/ui/hooks/use-device-channel.ts

import { useCallback, useRef } from 'react';
import type { CommandResult } from '@devbridge/shared';
import { wsClient } from '../../mw/ws/ws-client.js';
import { useWsEvent } from './use-ws-event.js';

const COMMAND_TIMEOUT_MS = 5000;

interface PendingEntry {
  resolve: (r: CommandResult) => void;
  reject:  (e: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

export interface DeviceChannelHook {
  sendCommand(
    commandId: string,
    params:    Record<string, unknown>,
  ): Promise<CommandResult>;
  subscribe(endpointIds?: string[]): void;
  unsubscribe(): void;
}

export function useDeviceChannel(deviceId: string): DeviceChannelHook {
  const pendingRef = useRef(new Map<string, PendingEntry>());

  // Resolve pending commands when device:response arrives
  useWsEvent<CommandResult>(
    'device:response',
    useCallback((result: CommandResult) => {
      const pending = pendingRef.current.get(result.correlationId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRef.current.delete(result.correlationId);
      if (result.success) {
        pending.resolve(result);
      } else {
        const err = Object.assign(
          new Error(result.errorMessage ?? 'Command failed'),
          { errorCode: result.errorCode },
        );
        pending.reject(err);
      }
    }, []),
  );

  const sendCommand = useCallback(
    (commandId: string, params: Record<string, unknown>): Promise<CommandResult> => {
      const correlationId = crypto.randomUUID();
      return new Promise<CommandResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(correlationId);
          reject(
            Object.assign(
              new Error(`Command timeout: ${commandId}`),
              { errorCode: 'COMMAND_TIMEOUT' },
            ),
          );
        }, COMMAND_TIMEOUT_MS);

        pendingRef.current.set(correlationId, { resolve, reject, timer });
        wsClient.send('device:command', {
          deviceId,
          commandId,
          params,
          correlationId,
        });
      });
    },
    [deviceId],
  );

  const subscribe = useCallback(
    (endpointIds?: string[]) => {
      wsClient.send('device:subscribe', { deviceId, endpointIds });
    },
    [deviceId],
  );

  const unsubscribe = useCallback(() => {
    wsClient.send('device:unsubscribe', { deviceId });
  }, [deviceId]);

  return { sendCommand, subscribe, unsubscribe };
}
