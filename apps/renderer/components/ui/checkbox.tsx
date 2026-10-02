import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input bg-background shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check className="size-3.5" aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/** Checkbox with clickable label text. */
export function CheckboxField({ label, className, id, children, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root> & { label?: React.ReactNode }) {
  const autoId = React.useId();
  const fieldId = id ?? autoId;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <Checkbox id={fieldId} className="mt-0.5" {...props} />
      <label htmlFor={fieldId} className="cursor-pointer text-sm leading-snug">
        {label ?? children}
      </label>
    </div>
  );
}
