import { describe, expect, it } from 'vitest';
import { retentionCutoff, TRANSMISSION_RETENTION_DAYS } from '../../packages/core/src/services/llm/transmission-retention';
import { previewOf } from '../../packages/core/src/services/llm/prompt-text';

describe('transmission retention', () => {
  it('keeps 90 days by default', () => {
    expect(TRANSMISSION_RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(new Date('2026-10-03T12:00:00.000Z'))).toBe('2026-07-05T12:00:00.000Z');
  });

  it('counts the given number of days back', () => {
    expect(retentionCutoff(new Date('2026-10-03T00:00:00.000Z'), 1)).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('log preview', () => {
  const masking = { personalData: true };

  it('prefers the preview the caller gives, masked and cut', () => {
    const preview = previewOf({ preview: `Frage: IBAN DE89 3704 0044 0532 0130 00 ${'x'.repeat(400)}` }, { sent: 'egal', masking });

    expect(preview.startsWith('Frage: IBAN [IBAN] xxx')).toBe(true);
    expect(preview).toHaveLength(280);
  });

  it('drops the standard frame lines from the sent text otherwise', () => {
    const sent = 'Antworte als JSON.\n\nHeutiges Datum: 2026-10-03 (Samstag)\nFrage:   Wie\nweit?';

    expect(previewOf({}, { sent, masking })).toBe('Frage: Wie weit?');
  });
});
