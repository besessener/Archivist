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
  const result = await call('settings:get');
  return { settings: normalizeSettings(result.settings), hasApiKey: result.hasApiKey };
}

export function useSettings() {
  const query = useQuery('settings:get', {}, { scopes: ['settings'] });
  const settings = useMemo(() => (query.data ? normalizeSettings(query.data.settings) : undefined), [query.data]);
  return { settings, hasApiKey: query.data?.hasApiKey ?? false, loading: query.loading, error: query.error, refetch: query.refetch };
}
