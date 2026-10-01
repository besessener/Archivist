'use client';

import { AppProvider } from '@/lib/app-context';
import { ToastProvider } from '@/lib/toast';
import { AppShell } from './shell/app-shell';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppProvider>
        <AppShell>{children}</AppShell>
      </AppProvider>
    </ToastProvider>
  );
}
