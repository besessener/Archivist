'use client';

import { useMemo } from 'react';
import { Settings } from '@archivist/shared';
import { call } from './ipc';
import { useQuery } from './use-query';

/** Normalizes settings (fills in default values), since the channel returns input types. */
export function normalizeSettings(raw: unknown): Settings {
  return Settings.parse(raw);
}

export async function loadSettings(): Promise<{ settings: Settings; hasApiKey: boolean }> {
  const res = await call('settings:get');
  return { settings: normalizeSettings(res.settings), hasApiKey: res.hasApiKey };
}

export function useSettings() {
  const q = useQuery('settings:get', {}, { scopes: ['settings'] });
  const settings = useMemo(() => (q.data ? normalizeSettings(q.data.settings) : undefined), [q.data]);
  return { settings, hasApiKey: q.data?.hasApiKey ?? false, loading: q.loading, error: q.error, refetch: q.refetch };
}
