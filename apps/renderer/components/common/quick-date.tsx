'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addDays, nextMonday, toIsoDay } from '@/lib/utils';

/** Quick selection: tomorrow / in 7 days / next Monday / date. */
export function QuickDate({ onPick, disabled }: { onPick: (isoDay: string) => void; disabled?: boolean }) {
  const [custom, setCustom] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPick(toIsoDay(addDays(1)))} data-testid="quick-tomorrow">
          Morgen
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPick(toIsoDay(addDays(7)))} data-testid="quick-week">
          In 7 Tagen
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPick(toIsoDay(nextMonday()))} data-testid="quick-monday">
          Nächsten Montag
        </Button>
      </div>
      <div className="flex gap-2">
        <Input type="date" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Datum wählen" className="h-8" />
        <Button size="sm" disabled={disabled || !custom} onClick={() => onPick(custom)} data-testid="quick-custom">
          Übernehmen
        </Button>
      </div>
    </div>
  );
}
