// packages/server/src/protocol/protocol-registry.ts
// Protocol registry with JSON/YAML schema loading and hot-reload via chokidar.

import { readFile, readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { EventEmitter } from 'node:events';

import type { ProtocolSchema } from '@devbridge/shared';

import { DynamicProtocol } from './dynamic-protocol.js';

// Optional YAML support — only required if .yaml/.yml schemas are used.
let yamlParse: ((src: string) => unknown) | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  yamlParse = require('js-yaml').load as (src: string) => unknown;
} catch {
  // YAML not available — JSON-only mode
}

// Optional chokidar for hot-reload.
type Watcher = { close(): Promise<void> };
let chokidar: { watch(path: string, opts?: object): Watcher & EventEmitter } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  chokidar = require('chokidar');
} catch {
  // Hot-reload disabled
}

export interface ProtocolRegistryOptions {
  /** Path to directory containing .json / .yaml protocol schema files. */
  schemasDir?: string;
  /** Run example round-trip tests on load (default: true). */
  validateExamples?: boolean;
}

export class ProtocolRegistry extends EventEmitter {
  private readonly map = new Map<string, DynamicProtocol>();
  private watcher?: Watcher;

  // ──────────────────────────────────────────────────────────
  // Load
  // ──────────────────────────────────────────────────────────

  async loadFromDir(dir: string, options: ProtocolRegistryOptions = {}): Promise<void> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
        await this.loadFromFile(join(dir, entry), options);
      }
    }
  }

  async loadFromFile(filePath: string, options: ProtocolRegistryOptions = {}): Promise<DynamicProtocol> {
    const src    = await readFile(filePath, 'utf-8');
    const ext    = extname(filePath).toLowerCase();
    let schema: ProtocolSchema;

    if (ext === '.json') {
      schema = JSON.parse(src) as ProtocolSchema;
    } else if ((ext === '.yaml' || ext === '.yml') && yamlParse) {
      schema = yamlParse(src) as ProtocolSchema;
    } else {
      throw new Error(`PROTOCOL_LOAD_FAILED: unsupported extension '${ext}' (install js-yaml for YAML support)`);
    }

    return this.register(schema, options);
  }

  register(schema: ProtocolSchema, options: ProtocolRegistryOptions = {}): DynamicProtocol {
    const protocol = new DynamicProtocol(schema);

    if (options.validateExamples !== false && schema.examples?.length) {
      try {
        protocol.runExamples();
      } catch (err) {
        throw Object.assign(
          new Error(`PROTOCOL_LOAD_FAILED: example validation failed for '${schema.name}': ${String(err)}`),
          { errorCode: 'PROTOCOL_LOAD_FAILED', cause: err },
        );
      }
    }

    this.atomicReplace(schema.name, protocol);
    return protocol;
  }

  // ──────────────────────────────────────────────────────────
  // Query
  // ──────────────────────────────────────────────────────────

  get(name: string): DynamicProtocol | undefined {
    return this.map.get(name);
  }

  getOrThrow(name: string): DynamicProtocol {
    const p = this.map.get(name);
    if (!p) {
      throw Object.assign(
        new Error(`PROTOCOL_NOT_FOUND: protocol '${name}' is not registered`),
        { errorCode: 'PROTOCOL_NOT_FOUND' },
      );
    }
    return p;
  }

  list(): string[] {
    return [...this.map.keys()];
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  // ──────────────────────────────────────────────────────────
  // Atomic replace (used for hot-reload)
  // ──────────────────────────────────────────────────────────

  atomicReplace(name: string, protocol: DynamicProtocol): void {
    const previous = this.map.get(name);
    this.map.set(name, protocol);
    this.emit('replaced', { name, protocol, previous });
  }

  // ──────────────────────────────────────────────────────────
  // Hot-reload watcher
  // ──────────────────────────────────────────────────────────

  startWatching(dir: string, options: ProtocolRegistryOptions = {}): void {
    if (!chokidar) {
      this.emit('warn', 'chokidar not available — hot-reload disabled');
      return;
    }

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    (this.watcher as unknown as EventEmitter).on('add', (p: string) => this.onFileChange(p, options));
    (this.watcher as unknown as EventEmitter).on('change', (p: string) => this.onFileChange(p, options));
    (this.watcher as unknown as EventEmitter).on('unlink', (p: string) => {
      const name = basename(p, extname(p));
      this.map.delete(name);
      this.emit('removed', { name });
    });
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private async onFileChange(filePath: string, options: ProtocolRegistryOptions): Promise<void> {
    try {
      const protocol = await this.loadFromFile(filePath, options);
      this.emit('reloaded', { name: protocol.name });
    } catch (err) {
      this.emit('reload-error', { filePath, error: err });
    }
  }
}
