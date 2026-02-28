// packages/frontend/src/mw/stores/plugin-store.ts

import { create } from 'zustand';
import type { PluginInfo } from '@devbridge/shared';

export interface PluginStoreState {
  plugins: Map<string, PluginInfo>;
  upsertPlugin(info: PluginInfo): void;
  removePlugin(pluginId: string): void;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: new Map(),

  upsertPlugin(info) {
    set(s => {
      s.plugins.set(info.pluginId, info);
      return { plugins: new Map(s.plugins) };
    });
  },

  removePlugin(pluginId) {
    set(s => {
      s.plugins.delete(pluginId);
      return { plugins: new Map(s.plugins) };
    });
  },
}));
