import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-5 flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className, wide = false }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full p-4 sm:p-6', wide ? 'max-w-7xl 2xl:max-w-[96rem]' : 'max-w-5xl 2xl:max-w-7xl', className)}>{children}</div>;
}
