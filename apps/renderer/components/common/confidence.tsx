import { Badge } from '@/components/ui/badge';
import { formatPercent } from '@/lib/format';

export function ConfidenceBadge({ value, label = 'Sicherheit' }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined) return null;
  const variant = value >= 0.8 ? 'success' : value >= 0.5 ? 'warning' : 'danger';
  return (
    <Badge variant={variant} title="Wie sicher sich die KI bei dieser Einschätzung ist" data-testid="confidence">
      {label} {formatPercent(value)}
    </Badge>
  );
}
