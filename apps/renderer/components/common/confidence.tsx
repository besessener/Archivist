import { Badge } from '@/components/ui/badge';
import { confidenceWord } from '@/lib/format';

/** A rough estimate in words (#167): the values are self-reports of the AI or rule defaults, not measured probabilities. */
export function ConfidenceBadge({ value, label = 'Einschätzung' }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined) return null;
  const variant = value >= 0.8 ? 'success' : value >= 0.5 ? 'warning' : 'danger';
  return (
    <Badge variant={variant} title="Grobe Einschätzung der Analyse – keine gemessene Wahrscheinlichkeit" data-testid="confidence">
      {label}: {confidenceWord(value)}
    </Badge>
  );
}
