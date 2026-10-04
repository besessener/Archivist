import { ReasoningEffort } from '@archivist/shared';
import { REASONING_EFFORT_LABELS } from '@/lib/labels';

const EFFORT_OPTIONS = ReasoningEffort.options.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] }));

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
