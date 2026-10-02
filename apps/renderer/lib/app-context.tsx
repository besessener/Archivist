'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStatus } from '@archivist/shared';
import { call, getBridge } from './ipc';
import { scopesOf, subscribe } from './events';
import { useToast } from './toast';
import type { ChatMsg, ImportResult } from './types';

export interface ImportState {
  startedAt: number;
  result: ImportResult;
}

interface AppContextValue {
  bridgeAvailable: boolean;
  status: AppStatus | null;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
  /** Last assistant reply for the right-hand context panel. */
  contextMessage: ChatMsg | null;
  setContextMessage: (m: ChatMsg | null) => void;
  importFiles: (files: File[]) => Promise<void>;
  importing: boolean;
  importState: ImportState | null;
  dismissImport: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { reportError } = useToast();
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [contextMessage, setContextMessage] = useState<ChatMsg | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [importing, setImporting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await call('app:getStatus'));
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Status konnte nicht geladen werden.');
    }
  }, []);

  useEffect(() => {
    setBridgeAvailable(getBridge() !== null);
    setChecked(true);
  }, []);

  useEffect(() => {
    if (!bridgeAvailable) return undefined;
    void refreshStatus();
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refreshStatus(), 200);
    };
    const offStatus = subscribe('status:changed', schedule);
    const offData = subscribe('data:changed', (payload) => {
      const scopes = scopesOf(payload);
      if (scopes.length === 0 || scopes.some((s) => ['notifications', 'jobs', 'insights', 'settings', 'documents'].includes(s))) schedule();
    });
    const offJob = subscribe('job:updated', schedule);
    return () => {
      offStatus();
      offData();
      offJob();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bridgeAvailable, refreshStatus]);

  const importFiles = useCallback(
    async (files: File[]) => {
      const bridge = getBridge();
      if (!bridge || files.length === 0) return;
      const paths: string[] = [];
      const localRejected: ImportResult['rejected'] = [];
      for (const f of files) {
        let p: string;
        try {
          p = bridge.getPathForFile(f);
        } catch {
          p = '';
        }
        if (p) paths.push(p);
        else localRejected.push({ path: f.name, reason: 'Der Dateipfad konnte nicht ermittelt werden (z. B. bei Dateien aus dem Browser oder aus Archiven).' });
      }
      if (paths.length === 0) {
        setImportState({ startedAt: Date.now(), result: { imported: [], duplicates: [], rejected: localRejected } });
        return;
      }
      setImporting(true);
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < paths.length; i += 200) chunks.push(paths.slice(i, i + 200));
        const merged: ImportResult = { imported: [], duplicates: [], rejected: [...localRejected] };
        for (const chunk of chunks) {
          const res = await call('documents:import', { paths: chunk });
          merged.imported.push(...res.imported);
          merged.duplicates.push(...res.duplicates);
          merged.rejected.push(...res.rejected);
        }
        setImportState({ startedAt: Date.now(), result: merged });
      } catch (err) {
        reportError(err, () => void importFiles(files), 'Import fehlgeschlagen');
      } finally {
        setImporting(false);
      }
    },
    [reportError],
  );

  const dismissImport = useCallback(() => setImportState(null), []);

  const value = useMemo<AppContextValue>(
    () => ({
      bridgeAvailable: checked && bridgeAvailable,
      status,
      statusError,
      refreshStatus,
      contextMessage,
      setContextMessage,
      importFiles,
      importing,
      importState,
      dismissImport,
    }),
    [checked, bridgeAvailable, status, statusError, refreshStatus, contextMessage, importFiles, importing, importState, dismissImport],
  );

  if (!checked) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp used outside of AppProvider');
  return ctx;
}
