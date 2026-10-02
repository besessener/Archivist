import { Fragment } from 'react';
import { cn } from '@/lib/utils';

/** A file path that wraps after its separators instead of in the middle of a folder name. */
export function PathText({ path, className }: { path: string; className?: string }) {
  const segments = path.split(/(?<=[\\/])/);
  return (
    <span className={cn('[overflow-wrap:anywhere]', className)}>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment}
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}
