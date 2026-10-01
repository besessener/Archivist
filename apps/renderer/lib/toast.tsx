'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from './utils';
import { IpcError } from './ipc';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

interface ToastApi {
  toast: (t: ToastInput) => void;
  /** Zeigt einen Fehler verständlich an; bei `retryable` mit „Erneut versuchen“. */
  reportError: (err: unknown, retry?: () => void, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (t: ToastInput) => {
      const id = ++counter.current;
      const item: ToastItem = {
        id,
        title: t.title,
        variant: t.variant ?? 'info',
        ...(t.description ? { description: t.description } : {}),
        ...(t.actionLabel ? { actionLabel: t.actionLabel } : {}),
        ...(t.onAction ? { onAction: t.onAction } : {}),
      };
      setItems((prev) => [...prev.slice(-4), item]);
      const duration = t.durationMs ?? (t.variant === 'error' ? 12000 : 5000);
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const reportError = useCallback(
    (err: unknown, retry?: () => void, title?: string) => {
      if (err instanceof IpcError) {
        toast({
          variant: 'error',
          title: title ?? err.title,
          description: err.message,
          ...(err.retryable && retry ? { actionLabel: 'Erneut versuchen', onAction: retry } : {}),
        });
      } else {
        toast({
          variant: 'error',
          title: title ?? 'Etwas ist schiefgelaufen',
          description: err instanceof Error ? err.message : 'Unbekannter Fehler.',
          ...(retry ? { actionLabel: 'Erneut versuchen', onAction: retry } : {}),
        });
      }
    },
    [toast],
  );

  const api = useMemo(() => ({ toast, reportError }), [toast, reportError]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
        data-testid="toasts"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            data-testid="toast"
            className={cn(
              'pointer-events-auto flex gap-3 rounded-lg border bg-card p-3 text-sm shadow-lg',
              t.variant === 'error' && 'border-destructive/50',
            )}
          >
            <span className="mt-0.5 shrink-0">
              {t.variant === 'error' ? (
                <AlertCircle className="size-4 text-destructive" aria-hidden />
              ) : t.variant === 'success' ? (
                <CheckCircle2 className="size-4 text-success" aria-hidden />
              ) : (
                <Info className="size-4 text-primary" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              {t.description && <p className="mt-0.5 break-words text-muted-foreground">{t.description}</p>}
              {t.actionLabel && t.onAction && (
                <button
                  type="button"
                  className="mt-2 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    t.onAction?.();
                    dismiss(t.id);
                  }}
                >
                  {t.actionLabel}
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Meldung schließen"
              className="h-fit rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => dismiss(t.id)}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast außerhalb von ToastProvider');
  return ctx;
}
