// packages/frontend/src/mw/stores/metrics-store.ts

import { create } from 'zustand';

export interface MetricsSnapshot {
  timestamp:       number;
  cpuPercent:      number;
  memoryMb:        number;
  activeDevices:   number;
  bytesInPerSec:   number;
  bytesOutPerSec:  number;
  pendingCommands: number;
  wsClientCount:   number;
}

export interface MetricsStoreState {
  snapshots: MetricsSnapshot[]; // max 60 (= 5 min @ 5 s interval)
  push(snapshot: MetricsSnapshot): void;
  latest(): MetricsSnapshot | undefined;
}

export const useMetricsStore = create<MetricsStoreState>((set, get) => ({
  snapshots: [],

  push(snapshot) {
    set(s => ({ snapshots: [...s.snapshots, snapshot].slice(-60) }));
  },

  latest() {
    return get().snapshots.at(-1);
  },
}));
