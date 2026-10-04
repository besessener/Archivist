'use client';

import { OCR_LANGUAGE_CHOICES } from '@archivist/shared';
import { CheckboxField } from '@/components/ui/checkbox';

/** Languages of the text recognition: only those whose data ships with the app, at least one stays selected. */
export function OcrLanguages({ languages, disabled, onChange }: { languages: string; disabled: boolean; onChange: (languages: string) => void }) {
  const selected = new Set(languages.split('+'));
  const toggle = (code: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(code);
    else next.delete(code);
    onChange(
      OCR_LANGUAGE_CHOICES.filter((choice) => next.has(choice.code))
        .map((choice) => choice.code)
        .join('+'),
    );
  };
  const onlyOne = OCR_LANGUAGE_CHOICES.filter((choice) => selected.has(choice.code)).length <= 1;
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
            onCheckedChange={(checked) => toggle(choice.code, checked === true)}
            data-testid={`settings-ocr-language-${choice.code}`}
          />
        ))}
      </div>
    </fieldset>
  );
}
