import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnalysisCoverage, isOcrLanguageList, OCR_LANGUAGE_CHOICES } from '@archivist/shared';

describe('OCR language choices', () => {
  it('are exactly the language data packages the app ships with', () => {
    const installed = fs.readdirSync(path.resolve(__dirname, '../../node_modules/@tesseract.js-data')).toSorted();
    expect(OCR_LANGUAGE_CHOICES.map((choice) => choice.code).toSorted()).toEqual(installed);
  });

  it('form valid language lists in every combination the settings can save', () => {
    for (const list of ['deu', 'eng', 'deu+eng']) expect(isOcrLanguageList(list)).toBe(true);
  });
});

describe('analysis coverage of rows stored before #226', () => {
  it('defaults the skipped OCR pages to zero', () => {
    const stored = { textChars: 10, llmChars: 10, llmParts: 1, extractionTruncated: false };
    expect(AnalysisCoverage.parse(stored).ocrPagesSkipped).toBe(0);
    expect(AnalysisCoverage.parse({ ...stored, ocrPagesSkipped: 4 }).ocrPagesSkipped).toBe(4);
  });
});
