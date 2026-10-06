import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { IpcError } from '@/lib/ipc';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center', className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-8">{icon}</div>}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Wird geladen …', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground', className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry, className }: { error: IpcError | Error | string; onRetry?: () => void; className?: string }) {
  const message = typeof error === 'string' ? error : error.message;
  const retryable = typeof error === 'string' ? true : 'retryable' in error ? error.retryable : true;
  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-sm', className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Das hat leider nicht geklappt.</p>
        <p className="break-words text-muted-foreground">{message}</p>
      </div>
      {onRetry && retryable && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Erneut versuchen
        </Button>
      )}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  className,
  ...rest
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children?: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 text-sm',
        tone === 'info' && 'border-info/30 bg-info/8',
        tone === 'warning' && 'border-warning/50 bg-warning-surface/60',
        tone === 'danger' && 'border-destructive/40 bg-destructive/8',
        className,
      )}
      {...rest}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn(title && 'mt-1', 'text-muted-foreground [&_strong]:text-foreground')}>{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  /** Shown below the field as `${htmlFor}-error`; the input points to it with `aria-describedby`. */
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && htmlFor && (
        <p id={`${htmlFor}-error`} className="text-xs text-destructive" data-testid={`${htmlFor}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
