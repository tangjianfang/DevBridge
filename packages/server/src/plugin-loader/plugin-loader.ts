// packages/server/src/plugin-loader/plugin-loader.ts

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { build } from 'esbuild';
import type { IService, ServiceHealth, ServiceMetrics, IPCMessage, PluginManifest, PluginInfo } from '@devbridge/shared';
import { sandboxPlugin } from './sandbox-plugin.js';
import { validatePluginExports, RUNTIME_FORBIDDEN } from './plugin-validator.js';

// ── Constants ──────────────────────────────────────────────────────────────

const FORBIDDEN_MODULES: readonly string[] = [
  'node-hid', 'serialport', '@abandonware/noble',
  'child_process', 'worker_threads', 'cluster',
];

const MAX_RESTARTS          = 3;
const HOT_UPDATE_TIMEOUT_MS = 10_000;

// ── Module-level IPC sender (toward Main Thread) ───────────────────────────

let _ipcSend: ((msg: Partial<IPCMessage>) => void) | null = null;

export function setPluginLoaderIpcSend(fn: (msg: Partial<IPCMessage>) => void): void {
  _ipcSend = fn;
}

// ── Child process factory (injectable for tests) ───────────────────────────

export type ChildProcessFactory = (entry: string, env?: NodeJS.ProcessEnv) => ChildProcess;

const defaultCpFactory: ChildProcessFactory = (entry, env = {}) =>
  fork(entry, [], { env: { ...process.env, ...env }, silent: true });

// ── PluginLoader ───────────────────────────────────────────────────────────

export class PluginLoader implements IService {
  readonly serviceId = 'plugin-loader';

  private readonly _children = new Map<string, ChildProcess>();
  private readonly _infos    = new Map<string, PluginInfo>();
  private readonly _cpFactory: ChildProcessFactory;
  private _messageCount = 0;
  private _errorCount   = 0;
  private readonly _startedAt = Date.now();

  constructor(cpFactory?: ChildProcessFactory) {
    this._cpFactory = cpFactory ?? defaultCpFactory;
  }

  // ── IService lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Passive — responds to IPC messages
  }

  async stop(): Promise<void> {
    const pluginIds = [...this._infos.keys()];
    await Promise.allSettled(pluginIds.map(id => this._drainAndKill(id, 'service stopping')));
  }

  async health(): Promise<ServiceHealth> {
    const running  = [...this._infos.values()].filter(i => i.status === 'running').length;
    const errored  = [...this._infos.values()].filter(i => i.status === 'error'  ).length;
    return {
      status:  errored > 0 ? 'degraded' : 'healthy',
      details: { plugins: this._infos.size, running, errored },
    };
  }

  metrics(): ServiceMetrics {
    return {
      uptime:       BigInt(Date.now() - this._startedAt),
      messageCount: this._messageCount,
      errorCount:   this._errorCount,
      plugins:      this._infos.size,
    };
  }

  // ── IPC handler ────────────────────────────────────────────────────────────

  handleIPCMessage(msg: Partial<IPCMessage>): void {
    this._messageCount++;
    const p = msg.payload as Record<string, unknown> | undefined;
    switch (msg.type) {
      case 'PLUGIN_LOAD':
        this._loadPlugin((p?.['manifestPath'] as string) ?? '').catch(e => {
          this._errorCount++;
          console.error('[PluginLoader] PLUGIN_LOAD error', e);
        });
        break;
      case 'PLUGIN_UNLOAD':
        this._drainAndKill((p?.['pluginId'] as string) ?? '', 'manual unload').catch(() => {});
        break;
      case 'PLUGIN_HOT_UPDATE_SOURCE':
        this.hotUpdate(
          (p?.['pluginId'] as string) ?? '',
          (p?.['source']   as string) ?? '',
        ).catch(e => console.error('[PluginLoader] hotUpdate error', e));
        break;
      case 'PLUGIN_RESTART':
        this._restartPlugin((p?.['pluginId'] as string) ?? '').catch(() => {});
        break;
    }
  }

  // ── Plugin loading ─────────────────────────────────────────────────────────

  private async _loadPlugin(manifestPath: string): Promise<PluginInfo> {
    const raw  = await fs.promises.readFile(manifestPath, 'utf-8');
    const manifest: PluginManifest = JSON.parse(raw) as PluginManifest;

    const pluginId  = `${manifest.name}@${manifest.version}-${crypto.randomUUID().slice(0, 8)}`;
    const entryPath = path.resolve(path.dirname(manifestPath), manifest.entry);

    const info: PluginInfo = {
      pluginId,
      version:         manifest.version,
      status:          'loading',
      manifestPath,
      assignedDevices: [],
      restartCount:    0,
    };
    this._infos.set(pluginId, info);
    this._sendStatusIPC(info);

    try {
      const child = this._spawnPlugin(pluginId, manifest, entryPath);
      await this._waitForIPC(child, 'PLUGIN_READY', 15_000);
      info.status   = 'running';
      info.pid      = child.pid;
      info.loadedAt = Date.now();
      this._sendStatusIPC(info);
      _ipcSend?.({ type: 'PLUGIN_LOADED', payload: info });
      return info;
    } catch (err) {
      info.status    = 'error';
      info.lastError = (err as Error).message;
      this._errorCount++;
      this._sendStatusIPC(info);
      throw err;
    }
  }

  // ── Hot update ─────────────────────────────────────────────────────────────

  async hotUpdate(pluginId: string, newSource: string): Promise<PluginInfo> {
    const info = this._getInfo(pluginId);
    const prevStatus = info.status;
    info.status = 'loading';
    this._sendStatusIPC(info);

    try {
      // 1. esbuild compile with sandbox intercept
      const buildResult = await build({
        stdin:    { contents: newSource, loader: 'ts' },
        bundle:   true,
        format:   'cjs',
        platform: 'node',
        write:    false,
        plugins:  [sandboxPlugin(FORBIDDEN_MODULES)],
        logLevel: 'silent',
      });

      const cjsCode = buildResult.outputFiles?.[0]?.text;
      if (!cjsCode) throw new Error('PLUGIN_LOAD_FAILED: esbuild produced no output');

      // 2. vm round-trip validation
      await validatePluginExports(cjsCode);

      // 3. Write to tmp file
      const tmpPath = path.join(
        os.tmpdir(),
        `devbridge-plugin-${pluginId}-${Date.now()}.cjs`,
      );
      await fs.promises.writeFile(tmpPath, cjsCode, 'utf-8');

      // 4. Notify child process
      const child = this._children.get(pluginId);
      if (!child) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId} has no child process`);
      child.send({ type: 'PLUGIN_HOT_UPDATE', payload: { tmpPath } });

      // 5. Wait for confirmation
      await this._waitForIPC(child, 'PLUGIN_HOT_UPDATED', HOT_UPDATE_TIMEOUT_MS);

      info.status = 'running';
      this._sendStatusIPC(info);
      _ipcSend?.({ type: 'PLUGIN_HOT_UPDATED', payload: { pluginId, version: info.version } });

      // Clean up tmp file (best-effort)
      fs.promises.unlink(tmpPath).catch(() => {});

      return info;

    } catch (err) {
      info.status    = 'error';
      info.lastError = (err as Error).message;
      this._errorCount++;
      this._sendStatusIPC(info);

      // Restore status if rollback possible (old child still alive)
      if (this._children.has(pluginId)) {
        const child = this._children.get(pluginId);
        if (child && !child.killed) {
          info.status = prevStatus;
          this._sendStatusIPC(info);
        }
      }
      throw err;
    }
  }

  // ── Spawn + lifecycle helpers ──────────────────────────────────────────────

  private _spawnPlugin(
    pluginId: string,
    manifest: PluginManifest,
    entryPath: string,
  ): ChildProcess {
    const child = this._cpFactory(entryPath, {
      DEVBRIDGE_PLUGIN_ID: pluginId,
      DEVBRIDGE_MANIFEST:  JSON.stringify(manifest),
    });

    this._children.set(pluginId, child);

    child.on('message', (msg: IPCMessage) => {
      this._messageCount++;
      if (msg.type === 'LOG_ENTRY') {
        _ipcSend?.({ type: 'LOG_ENTRY', payload: { ...msg.payload as object, pluginId } });
      } else if (msg.type === 'PLUGIN_STATUS') {
        this._sendStatusIPC(this._getInfo(pluginId));
      }
    });

    child.on('exit', (code, signal) => {
      const info = this._infos.get(pluginId);
      if (!info) return;
      if (info.status === 'stopping' || info.status === 'draining') return; // expected exit

      info.status = 'crashed';
      this._errorCount++;
      _ipcSend?.({ type: 'PLUGIN_CRASHED', payload: { pluginId, exitCode: code, signal } });
      this._sendStatusIPC(info);

      if (info.restartCount < MAX_RESTARTS) {
        info.status = 'restarting';
        this._sendStatusIPC(info);
        info.restartCount++;
        this._restartPlugin(pluginId).catch(() => {});
      } else {
        info.status    = 'error';
        info.lastError = `Crashed ${info.restartCount} times. Max restarts reached.`;
        this._errorCount++;
        this._sendStatusIPC(info);
      }
    });

    child.on('error', (err) => {
      this._errorCount++;
      console.error(`[PluginLoader] child process error for ${pluginId}:`, err.message);
    });

    return child;
  }

  private async _drainAndKill(pluginId: string, reason: string): Promise<void> {
    const info  = this._infos.get(pluginId);
    const child = this._children.get(pluginId);
    if (!info || !child) return;

    info.status = 'draining';
    this._sendStatusIPC(info);

    try {
      child.send({ type: 'PLUGIN_STOP', payload: { reason } });
      await this._waitForIPC(child, 'PLUGIN_STOPPED', 5_000);
    } catch { /* timeout — force kill */ }

    info.status = 'stopping';
    this._sendStatusIPC(info);

    try { if (!child.killed) child.kill(); } catch { /* ignore */ }

    info.status = 'idle';
    this._sendStatusIPC(info);

    this._children.delete(pluginId);
  }

  private async _restartPlugin(pluginId: string): Promise<void> {
    const info = this._getInfo(pluginId);
    const manifest: PluginManifest = JSON.parse(
      await fs.promises.readFile(info.manifestPath, 'utf-8'),
    ) as PluginManifest;
    const entryPath = path.resolve(path.dirname(info.manifestPath), manifest.entry);

    // Remove old child
    const old = this._children.get(pluginId);
    if (old && !old.killed) { try { old.kill(); } catch { /* ignore */ } }
    this._children.delete(pluginId);

    info.status = 'loading';
    this._sendStatusIPC(info);

    try {
      const child = this._spawnPlugin(pluginId, manifest, entryPath);
      await this._waitForIPC(child, 'PLUGIN_READY', 15_000);
      info.status   = 'running';
      info.pid      = child.pid;
      info.loadedAt = Date.now();
      this._sendStatusIPC(info);
    } catch (err) {
      info.status    = 'error';
      info.lastError = (err as Error).message;
      this._errorCount++;
      this._sendStatusIPC(info);
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  getInfo(pluginId: string): PluginInfo | undefined {
    return this._infos.get(pluginId);
  }

  listPlugins(): PluginInfo[] {
    return [...this._infos.values()];
  }

  /**
   * Register a plugin directly (used by tests / when manifest is already parsed).
   */
  _registerPlugin(pluginId: string, manifest: PluginManifest, child: ChildProcess): PluginInfo {
    const info: PluginInfo = {
      pluginId,
      version:         manifest.version,
      status:          'running',
      manifestPath:    '',
      assignedDevices: [],
      restartCount:    0,
      pid:             child.pid,
      loadedAt:        Date.now(),
    };
    this._infos.set(pluginId, info);
    this._children.set(pluginId, child);

    child.on('message', (msg: IPCMessage) => {
      this._messageCount++;
      if (msg.type === 'LOG_ENTRY') {
        _ipcSend?.({ type: 'LOG_ENTRY', payload: { ...msg.payload as object, pluginId } });
      }
    });

    child.on('exit', (code, signal) => {
      const i = this._infos.get(pluginId);
      if (!i) return;
      if (i.status === 'stopping' || i.status === 'draining') return;

      i.status = 'crashed';
      this._errorCount++;
      _ipcSend?.({ type: 'PLUGIN_CRASHED', payload: { pluginId, exitCode: code, signal } });
      this._sendStatusIPC(i);

      if (i.restartCount < MAX_RESTARTS) {
        i.status = 'restarting';
        i.restartCount++;
        this._sendStatusIPC(i);
        // For tests: don't actually restart (no manifestPath)
        if (i.manifestPath) {
          this._restartPlugin(pluginId).catch(() => {});
        } else {
          i.status = 'error';
          i.lastError = `Crashed. (test: no manifestPath for restart)`;
          this._sendStatusIPC(i);
        }
      } else {
        i.status    = 'error';
        i.lastError = `Crashed ${i.restartCount} times. Max restarts reached.`;
        this._errorCount++;
        this._sendStatusIPC(i);
      }
    });

    return info;
  }

  private _getInfo(pluginId: string): PluginInfo {
    const info = this._infos.get(pluginId);
    if (!info) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
    return info;
  }

  private _sendStatusIPC(info: PluginInfo): void {
    _ipcSend?.({ type: 'PLUGIN_STATUS', payload: info });
  }

  private _waitForIPC(child: ChildProcess, type: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { child.off('message', handler); reject(new Error(`IPC timeout waiting for '${type}'`)); },
        timeout,
      );
      const handler = (msg: unknown) => {
        if ((msg as IPCMessage).type === type) {
          clearTimeout(timer);
          child.off('message', handler as NodeJS.MessageListener);
          resolve();
        }
      };
      child.on('message', handler as NodeJS.MessageListener);
    });
  }
}
