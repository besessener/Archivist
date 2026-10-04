'use client';

import { OCR_LANGUAGE_CHOICES } from '@archivist/shared';
import { CheckboxField } from '@/components/ui/checkbox';
import { ocrLanguageCodes, otherOcrLanguages, toggleOcrLanguage } from '@/lib/ocr-languages';

/** Languages of the text recognition: those whose data ships with the app; other configured codes stay; at least one stays selected. */
export function OcrLanguages({ languages, disabled, onChange }: { languages: string; disabled: boolean; onChange: (languages: string) => void }) {
  const selected = new Set(ocrLanguageCodes(languages));
  const others = otherOcrLanguages(languages);
  const onlyOne = selected.size <= 1;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="settings-ocr-languages">
      <legend className="text-sm font-medium">Sprachen der Texterkennung</legend>
      <p className="text-xs text-muted-foreground">
        Wähle die Sprachen, in denen deine gescannten Dokumente verfasst sind. Mindestens eine Sprache bleibt gewählt.
      </p>
      <div className="flex flex-wrap gap-4">
        {OCR_LANGUAGE_CHOICES.map((choice) => (
          <CheckboxField
            key={choice.code}
            label={choice.label}
            checked={selected.has(choice.code)}
            disabled={disabled || (onlyOne && selected.has(choice.code))}
            onCheckedChange={(checked) => onChange(toggleOcrLanguage(languages, { code: choice.code, checked: checked === true }))}
            data-testid={`settings-ocr-language-${choice.code}`}
          />
        ))}
      </div>
      {others.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="settings-ocr-other-languages">
          Außerdem eingestellt (aus der Konfigurationsdatei, bleibt erhalten): {others.join(', ')}
        </p>
      )}
    </fieldset>
  );
}
