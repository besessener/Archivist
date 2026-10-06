import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A secondary card action shown as its icon only; the label is the accessible name and the tooltip. */
export function IconAction({ label, className, ...props }: { label: string } & Omit<ButtonProps, 'size' | 'variant' | 'title' | 'aria-label'>) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      {...props}
    />
  );
}
