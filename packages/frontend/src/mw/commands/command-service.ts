// packages/frontend/src/mw/commands/command-service.ts

import type { CommandResult, BroadcastResult } from '@devbridge/shared';

export interface CommandService {
  /** Send a command to a single device, await REST response. */
  sendCommand(
    deviceId:  string,
    commandId: string,
    params:    Record<string, unknown>,
    options?:  { timeoutMs?: number },
  ): Promise<CommandResult>;

  /** Broadcast a command to multiple devices. */
  broadcast(
    commandId: string,
    params:    Record<string, unknown>,
    deviceIds: string[],
  ): Promise<BroadcastResult>;
}

export const commandService: CommandService = {
  async sendCommand(deviceId, commandId, params, options) {
    const resp = await fetch(`/api/v1/devices/${deviceId}/command`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        commandId,
        params,
        timeoutMs: options?.timeoutMs,
      }),
    });
    const json = (await resp.json()) as
      | { data: CommandResult }
      | { error: unknown };
    if (!resp.ok || 'error' in json) throw json;
    return (json as { data: CommandResult }).data;
  },

  async broadcast(commandId, params, deviceIds) {
    const resp = await fetch('/api/v1/devices/broadcast', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ commandId, params, deviceIds }),
    });
    const json = (await resp.json()) as
      | { data: BroadcastResult }
      | { error: unknown };
    if (!resp.ok || 'error' in json) throw json;
    return (json as { data: BroadcastResult }).data;
  },
};
