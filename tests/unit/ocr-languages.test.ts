import { describe, expect, it } from 'vitest';
import { otherOcrLanguages, toggleOcrLanguage } from '../../apps/renderer/lib/ocr-languages';

describe('toggleOcrLanguage', () => {
  it('adds an offered language in the order the settings offer them', () => {
    expect(toggleOcrLanguage('eng', { code: 'deu', checked: true })).toBe('deu+eng');
  });

  it('removes an offered language', () => {
    expect(toggleOcrLanguage('deu+eng', { code: 'eng', checked: false })).toBe('deu');
  });

  it('keeps configured codes the settings do not offer', () => {
    expect(toggleOcrLanguage('deu+chi_sim+fra', { code: 'eng', checked: true })).toBe('deu+eng+chi_sim+fra');
    expect(toggleOcrLanguage('deu+eng+chi_sim', { code: 'deu', checked: false })).toBe('eng+chi_sim');
  });
});

describe('otherOcrLanguages', () => {
  it('lists only the codes the settings do not offer', () => {
    expect(otherOcrLanguages('deu+chi_sim+eng+fra')).toEqual(['chi_sim', 'fra']);
    expect(otherOcrLanguages('deu+eng')).toEqual([]);
  });
});
