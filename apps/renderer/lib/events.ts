import type { DataChangedPayload, EventChannel } from '@archivist/shared';
import { getBridge } from './ipc';

type Listener = (payload: unknown) => void;

const listeners = new Map<EventChannel, Set<Listener>>();
const unsubscribers = new Map<EventChannel, () => void>();

/** Teilt pro Kanal genau eine Bridge-Subscription unter allen Komponenten. */
export function subscribe(channel: EventChannel, listener: Listener): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(listener);
  if (!unsubscribers.has(channel)) {
    const bridge = getBridge();
    if (bridge) {
      const off = bridge.on(channel, (payload) => {
        for (const l of listeners.get(channel) ?? []) l(payload);
      });
      unsubscribers.set(channel, off);
    }
  }
  return () => {
    const s = listeners.get(channel);
    s?.delete(listener);
    if (s && s.size === 0) {
      unsubscribers.get(channel)?.();
      unsubscribers.delete(channel);
    }
  };
}

export function scopesOf(payload: unknown): string[] {
  if (payload && typeof payload === 'object' && 'scopes' in payload) {
    const scopes = (payload as Partial<DataChangedPayload>).scopes;
    if (Array.isArray(scopes)) return scopes.filter((s): s is string => typeof s === 'string');
  }
  return [];
}
