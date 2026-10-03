import type { ReasoningEffort } from '@archivist/shared';

export const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'keine (wird gesendet)' },
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'niedrig' },
  { value: 'medium', label: 'mittel' },
  { value: 'high', label: 'hoch' },
  { value: 'xhigh', label: 'sehr hoch' },
  { value: 'max', label: 'maximal' },
];

/** Options of the thinking-depth select; „Standard des Modells“ sends nothing. */
export function EffortOptions() {
  return (
    <>
      <option value="">Standard des Modells</option>
      {EFFORT_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </>
  );
}

export const EFFORT_HINT = 'Nur für Modelle mit „Reasoning“. Lehnt der Dienst eine Stufe ab, nimmt Archivist die höchste, die er kennt.';
