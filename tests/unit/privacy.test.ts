import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrivacyService } from '../../packages/core/src/services/privacy';
import type { SettingsService } from '../../packages/core/src/services/settings';

type PrivacySettings = {
  llmMode: 'auto' | 'confirm' | 'local_only';
  neverAnalyzeExtensions: string[];
  neverAnalyzeFiles: string[];
  neverAnalyzeDirs: string[];
};

/** Datenschutz-Gate mit festen Einstellungen (ohne Datenbank). */
const gate = (privacy: Partial<PrivacySettings> = {}) => {
  const settings = { get: () => ({ privacy: { llmMode: 'auto', neverAnalyzeExtensions: [], neverAnalyzeFiles: [], neverAnalyzeDirs: [], ...privacy } }) };
  return new PrivacyService(settings as unknown as SettingsService);
};

const allowed = { allowed: true, status: null, reason: null };

describe('Datenschutz-Gate: was darf an das externe LLM gehen?', () => {
  it('liefert den eingestellten Modus', () => {
    for (const llmMode of ['auto', 'confirm', 'local_only'] as const) expect(gate({ llmMode }).mode()).toBe(llmMode);
  });

  it('erlaubt eine gewöhnliche Datei', () => {
    expect(gate().evaluate({ path: '/daten/notiz.txt', ext: 'txt' })).toEqual(allowed);
    expect(gate().evaluate({ ext: '.pdf' })).toEqual(allowed);
  });

  it('sperrt im Modus „nur lokal“ alles, auch wenn sonst nichts dagegen spricht', () => {
    const decision = gate({ llmMode: 'local_only' }).evaluate({ path: '/daten/notiz.txt', ext: 'txt' });

    expect(decision).toEqual({ allowed: false, status: 'local_only', reason: 'Datenschutzmodus „nur lokal“ ist aktiv.' });
  });

  it('der Modus „nur lokal“ hat Vorrang vor allen anderen Gründen', () => {
    const decision = gate({ llmMode: 'local_only', neverAnalyzeExtensions: ['txt'] }).evaluate({ ext: 'txt', docExcluded: true, rootLlmAllowed: false });

    expect(decision.status).toBe('local_only');
  });

  it('sperrt Dokumente, die von der externen Analyse ausgeschlossen sind', () => {
    expect(gate().evaluate({ ext: 'txt', docExcluded: true })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Datei ist von der externen Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', docExcluded: false })).toEqual(allowed);
  });

  it('sperrt Dateien aus Scan-Verzeichnissen ohne LLM-Freigabe (nur bei ausdrücklichem false)', () => {
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: false })).toEqual({
      allowed: false,
      status: 'excluded',
      reason: 'Das Scan-Verzeichnis ist von der LLM-Analyse ausgeschlossen.',
    });
    expect(gate().evaluate({ ext: 'txt', rootLlmAllowed: true })).toEqual(allowed);
    expect(gate().evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt Dateitypen aus der Liste, unabhängig von Groß-/Kleinschreibung und führendem Punkt', () => {
    const privacy = gate({ neverAnalyzeExtensions: ['.KEY', 'pem'] });

    for (const ext of ['key', '.key', 'KEY', 'pem', '.PEM']) {
      expect(privacy.evaluate({ ext }), ext).toMatchObject({ allowed: false, status: 'excluded' });
    }
    expect(privacy.evaluate({ ext: 'key' }).reason).toBe('Dateityp .key wird nie extern analysiert.');
    expect(privacy.evaluate({ ext: 'keyx' })).toEqual(allowed);
    expect(privacy.evaluate({ ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt einzelne Dateien, auch bei unterschiedlich geschriebenem Pfad', () => {
    const privacy = gate({ neverAnalyzeFiles: ['/daten/geheim/../privat.txt'] });

    const decision = privacy.evaluate({ path: '/daten/privat.txt', ext: 'txt' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/privat.txt.bak', ext: 'bak' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/anderes/privat.txt', ext: 'txt' })).toEqual(allowed);
  });

  it('sperrt alles unterhalb gesperrter Verzeichnisse, aber nicht Nachbarn mit gleichem Namensanfang', () => {
    const privacy = gate({ neverAnalyzeDirs: ['/daten/steuer'] });

    const decision = privacy.evaluate({ path: '/daten/steuer/2025/bescheid.pdf', ext: 'pdf' });
    expect(decision).toEqual({ allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' });
    expect(privacy.evaluate({ path: '/daten/steuer', ext: '' })).toMatchObject({ allowed: false });
    expect(privacy.evaluate({ path: '/daten/steuer-alt/x.pdf', ext: 'pdf' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '/daten/x.pdf', ext: 'pdf' })).toEqual(allowed);
  });

  it('prüft Pfade nur, wenn einer angegeben ist', () => {
    const privacy = gate({ neverAnalyzeFiles: [path.resolve('.')], neverAnalyzeDirs: [path.resolve('.')] });

    expect(privacy.evaluate({ ext: 'txt' })).toEqual(allowed);
    expect(privacy.evaluate({ path: null, ext: 'txt' })).toEqual(allowed);
    expect(privacy.evaluate({ path: '', ext: 'txt' })).toEqual(allowed);
  });
});
