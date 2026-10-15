'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppStatus } from '@archivist/shared';
import { filePaths, PATH_UNKNOWN } from './file-paths';
import { call, getBridge } from './ipc';
import { scopesOf, subscribe } from './events';
import { useToast } from './toast';
import type { ChatMessage, ImportResult } from './types';

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
  contextMessage: ChatMessage | null;
  setContextMessage: (m: ChatMessage | null) => void;
  importFiles: (files: File[]) => Promise<void>;
  /** Asks for a folder and imports it with everything below it. */
  importFolder: () => Promise<void>;
  importing: boolean;
  importState: ImportState | null;
  dismissImport: () => void;
  /** A page that takes dropped files itself (the chat attaches them); without one, a drop imports into the inbox. */
  dropTarget: DropTarget | null;
  setDropTarget: (target: DropTarget | null) => void;
}

export interface DropTarget {
  /** Shown on the drop overlay. */
  hint: string;
  take: (files: File[]) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { reportError } = useToast();
  const [bridgeAvailable, setBridgeAvailable] = useState(false);
  const [checked, setChecked] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [contextMessage, setContextMessage] = useState<ChatMessage | null>(null);
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [importing, setImporting] = useState(false);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
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
      if (scopes.length === 0 || scopes.some((s) => ['notifications', 'jobs', 'insights', 'settings', 'documents', 'openItems', 'knowledge'].includes(s)))
        schedule();
    });
    const offJob = subscribe('job:updated', schedule);
    return () => {
      offStatus();
      offData();
      offJob();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bridgeAvailable, refreshStatus]);

  const theme = status?.theme ?? 'system';
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const importPaths = useCallback(
    async (paths: string[], localRejected: ImportResult['rejected']) => {
      if (paths.length === 0) {
        setImportState({ startedAt: Date.now(), result: { imported: [], duplicates: [], rejected: localRejected, folders: [] } });
        return;
      }
      setImporting(true);
      try {
        const chunks: string[][] = [];
        for (let i = 0; i < paths.length; i += 200) chunks.push(paths.slice(i, i + 200));
        const merged: ImportResult = { imported: [], duplicates: [], rejected: [...localRejected], folders: [] };
        for (const chunk of chunks) {
          const res = await call('documents:import', { paths: chunk });
          merged.imported.push(...res.imported);
          merged.duplicates.push(...res.duplicates);
          merged.rejected.push(...res.rejected);
          merged.folders.push(...res.folders);
        }
        setImportState({ startedAt: Date.now(), result: merged });
      } catch (err) {
        reportError(err, () => void importPaths(paths, localRejected), 'Import fehlgeschlagen');
      } finally {
        setImporting(false);
      }
    },
    [reportError],
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!getBridge() || files.length === 0) return;
      const { paths, unknown } = filePaths(files);
      await importPaths(
        paths,
        unknown.map((name) => ({ path: name, reason: PATH_UNKNOWN })),
      );
    },
    [importPaths],
  );

  const importFolder = useCallback(async () => {
    try {
      const { path } = await call('app:selectDirectory', { title: 'Ordner zum Importieren wählen' });
      if (path) await importPaths([path], []);
    } catch (err) {
      reportError(err, () => void importFolder(), 'Ordner konnte nicht gewählt werden');
    }
  }, [importPaths, reportError]);

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
      importFolder,
      importing,
      importState,
      dismissImport,
      dropTarget,
      setDropTarget,
    }),
    [checked, bridgeAvailable, status, statusError, refreshStatus, contextMessage, importFiles, importing, importState, dismissImport, dropTarget],
  );

  if (!checked) return null;
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp used outside of AppProvider');
  return ctx;
}
