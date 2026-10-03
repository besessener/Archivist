import { Button } from '@/components/ui/button';

interface LoadMoreProps {
  shown: number;
  total: number;
  /** Plural of what the list holds, e.g. „Entscheidungen“. */
  noun: string;
  onMore: () => void;
  loading: boolean;
  testId: string;
}

/** Below a paged list: how much of it is shown and „Mehr laden“ while more exists. */
export function LoadMore({ shown, total, noun, onMore, loading, testId }: LoadMoreProps) {
  if (total <= shown) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground" data-testid={`${testId}-capped`}>
      <p>
        Angezeigt werden {shown.toLocaleString('de-DE')} von {total.toLocaleString('de-DE')} {noun}.
      </p>
      <Button variant="outline" size="sm" onClick={onMore} disabled={loading} data-testid={`${testId}-load-more`}>
        Mehr laden
      </Button>
    </div>
  );
}
