// packages/server/src/index.ts
// DevBridge Server — main application entry point

import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';

import { GatewayService, setGatewayIpcSend } from './gateway/index.js';
import { CommandDispatcher } from './command-dispatcher/index.js';
import { DeviceManager } from './device-manager/index.js';
import { PluginLoader } from './plugin-loader/index.js';
import type { IPCMessage } from '@devbridge/shared';

// ── Portable source-dir resolution ─────────────────────────────────────────
// Works in:
//   • ESM dev (tsx watch)      – process.argv[1] = /path/to/packages/server/src/index.ts
//   • CJS bundle (esbuild)     – process.argv[1] = /path/to/server.cjs
//   • pkg EXE                  – process.execPath  = C:\...\devbridge.exe

// Directory of the current script / bundle
const _scriptDir = path.dirname(
  (process.argv[1] !== undefined && process.argv[1] !== '')
    ? path.resolve(process.argv[1])
    : process.execPath,
);

/**
 * Resolve the frontend static dir:
 * - In production (pkg bundle / installer): `<exe-dir>/public`
 * - In dev:  `<repo>/packages/frontend/dist`
 * Set DEVBRIDGE_STATIC_DIR env var to override.
 */
function resolveStaticDir(): string | undefined {
  if (process.env['DEVBRIDGE_STATIC_DIR']) {
    return process.env['DEVBRIDGE_STATIC_DIR'];
  }
  // pkg sets process.pkg when running inside a bundle
  const isPkg = typeof (process as Record<string, unknown>)['pkg'] !== 'undefined';
  if (isPkg) {
    const exeDir = path.dirname(process.execPath);
    return path.join(exeDir, 'public');
  }
  // Development: look for the built frontend in the monorepo
  const candidates = [
    path.resolve(_scriptDir, '..', '..', '..', 'packages', 'frontend', 'dist'),
    path.resolve(process.cwd(), 'packages', 'frontend', 'dist'),
    path.resolve(process.cwd(), 'dist', 'public'),
  ];
  return candidates.find(existsSync);
}

// ── Configuration (env-driven) ────────────────────────────────────────────────

const PORT      = parseInt(process.env['PORT']      ?? '4000', 10);
const MODE      = (process.env['DEVBRIDGE_MODE']    ?? 'local') as 'local' | 'lan';
const API_KEY   = process.env['DEVBRIDGE_API_KEY'];
const CORS_ORIGINS = process.env['CORS_ORIGINS']
  ? process.env['CORS_ORIGINS'].split(',').map(s => s.trim())
  : [];

// ── Service instantiation ─────────────────────────────────────────────────────

const gw  = new GatewayService();
const cmd = new CommandDispatcher();
const dm  = new DeviceManager();
const pl  = new PluginLoader();

// ── IPC wiring ────────────────────────────────────────────────────────────────
//
//  GatewayService  ──(COMMAND)──►  CommandDispatcher  ──(COMMAND_SEND)──►  DeviceManager
//  GatewayService  ◄──(RESULT)──   CommandDispatcher  ◄──(DATA_RECEIVED)── DeviceManager
//  GatewayService  ◄──(events)──   DeviceManager

setGatewayIpcSend((msg: Partial<IPCMessage>) => {
  cmd.handleIPCMessage(msg);
  dm.handleIPCMessage(msg);
});

cmd.configureIPC(
  (msg) => gw.handleIPCMessage(msg),          // upstream  → GatewayService
  (msg) => dm.handleIPCMessage(msg),           // downstream → DeviceManager
);

dm.configureIPC((msg: IPCMessage) => {
  if (msg.type === 'DATA_RECEIVED') {
    cmd.handleIPCMessage(msg);
  } else {
    gw.handleIPCMessage(msg);
  }
});

// ── Gateway configuration ─────────────────────────────────────────────────────

const staticDir = resolveStaticDir();

gw.configure({
  mode:      MODE,
  port:      PORT,
  apiKey:    API_KEY,
  staticDir,
  cors: {
    enabled: CORS_ORIGINS.length > 0,
    origins: CORS_ORIGINS,
  },
  rateLimit: {
    max:        parseInt(process.env['RATE_LIMIT_MAX']        ?? '100', 10),
    timeWindow: process.env['RATE_LIMIT_WINDOW']              ?? '1 minute',
  },
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  console.log('[DevBridge] Starting services…');

  await dm.start();
  await cmd.start();
  await pl.start();
  await gw.start();

  const addr = MODE === 'lan' ? '0.0.0.0' : '127.0.0.1';
  console.log(`[DevBridge] Gateway listening on http://${addr}:${PORT}`);
  if (staticDir) {
    console.log(`[DevBridge] Serving UI from ${staticDir}`);
  }
  console.log(`[DevBridge] Mode: ${MODE} | Version: 0.1.0-beta.1`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[DevBridge] Received ${signal}, shutting down…`);
  try {
    await gw.stop();
    await cmd.stop();
    await pl.stop();
    await dm.stop();
    console.log('[DevBridge] Shutdown complete.');
  } catch (err) {
    console.error('[DevBridge] Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGINT',  () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[DevBridge] Uncaught exception:', err);
  void stop('uncaughtException');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

start().catch((err) => {
  console.error('[DevBridge] Fatal startup error:', err);
  process.exit(1);
});
