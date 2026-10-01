'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { FileUp } from 'lucide-react';
import { useApp } from '@/lib/app-context';
import { ContextPanel } from './context-panel';
import { ImportCard } from './import-card';
import { NoBridge } from './no-bridge';
import { NotificationBell } from './notification-bell';
import { SearchBox } from './search-box';
import { SetupWizard } from './setup-wizard';
import { Sidebar } from './sidebar';
import { JobsIndicator, ServiceStatus } from './status-indicators';
import { Loading, Notice } from '@/components/common/states';

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { bridgeAvailable, status, statusError, importFiles } = useApp();
  const pathname = usePathname() ?? '';
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // Dateien, die neben dem Hauptbereich fallen gelassen werden, sollen nicht vom Browser geöffnet werden.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void importFiles(files);
    },
    [importFiles],
  );

  if (!bridgeAvailable) return <NoBridge />;
  if (!status) {
    return (
      <div className="flex h-screen items-center justify-center">
        {statusError ? (
          <Notice tone="danger" title="Archivist konnte nicht gestartet werden" className="max-w-md">
            {statusError}
          </Notice>
        ) : (
          <Loading label="Archivist wird gestartet …" />
        )}
      </div>
    );
  }
  if (!status.setupCompleted) return <SetupWizard />;

  const showContext = pathname.startsWith('/chat');

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4" data-testid="app-header">
          <div className="flex-1">
            <SearchBox />
          </div>
          <div className="flex items-center gap-0.5">
            <JobsIndicator />
            <ServiceStatus />
            <NotificationBell />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Dropzone für Dateien: Drag-Ereignisse sind die Funktion des Bereichs, Tastaturzugang bietet der Import-Dialog */}
          <main
            id="main"
            data-testid="dropzone"
            className="relative min-w-0 flex-1 overflow-y-auto"
            onDragEnter={(e) => {
              if (!hasFiles(e)) return;
              depth.current += 1;
              setDragging(true);
            }}
            onDragOver={(e) => {
              if (hasFiles(e)) e.preventDefault();
            }}
            onDragLeave={(e) => {
              if (!hasFiles(e)) return;
              depth.current = Math.max(0, depth.current - 1);
              if (depth.current === 0) setDragging(false);
            }}
            onDrop={onDrop}
          >
            {children}
            {dragging && (
              <div
                className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
                data-testid="dropzone-overlay"
              >
                <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-card px-10 py-8 text-center shadow-lg">
                  <FileUp className="size-8 text-primary" aria-hidden />
                  <p className="font-medium">Dateien hier ablegen</p>
                  <p className="text-sm text-muted-foreground">Sie landen zuerst in der Inbox – nichts wird ohne Ihre Bestätigung archiviert.</p>
                </div>
              </div>
            )}
            <ImportCard />
          </main>
          {showContext && <ContextPanel />}
        </div>
      </div>
    </div>
  );
}
