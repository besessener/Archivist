import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-tight whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      success: 'border-transparent bg-success/15 text-success',
      warning: 'border-transparent bg-warning/20 text-warning',
      danger: 'border-transparent bg-destructive/15 text-destructive',
      info: 'border-transparent bg-primary/12 text-primary',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
