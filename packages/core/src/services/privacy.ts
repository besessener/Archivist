import path from 'node:path';
import type { LlmStatus } from '@archivist/shared';
import { isInside } from '../util/paths';
import type { SettingsService } from './settings';

export interface PrivacyDecision {
  /** Dürfen Inhalte an den externen LLM-Endpunkt gesendet werden? */
  allowed: boolean;
  /** Status für die UI, falls nicht erlaubt */
  status: Extract<LlmStatus, 'excluded' | 'local_only'> | null;
  reason: string | null;
}

/** Regeln, ob und welche Inhalte an das LLM übertragen werden dürfen (Datenschutz-Gate). */
export class PrivacyService {
  constructor(private readonly settings: SettingsService) {}

  mode(): 'auto' | 'confirm' | 'local_only' {
    return this.settings.get().privacy.llmMode;
  }

  evaluate(input: { path?: string | null; ext: string; docExcluded?: boolean; rootLlmAllowed?: boolean }): PrivacyDecision {
    const p = this.settings.get().privacy;
    if (p.llmMode === 'local_only') return { allowed: false, status: 'local_only', reason: 'Datenschutzmodus „nur lokal“ ist aktiv.' };
    if (input.docExcluded) return { allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' };
    if (input.rootLlmAllowed === false) return { allowed: false, status: 'excluded', reason: 'Das Scan-Verzeichnis ist von der LLM-Analyse ausgeschlossen.' };
    const ext = input.ext.toLowerCase().replace(/^\./, '');
    if (p.neverAnalyzeExtensions.some((e) => e.toLowerCase().replace(/^\./, '') === ext))
      return { allowed: false, status: 'excluded', reason: `Dateityp .${ext} wird nie extern analysiert.` };
    if (input.path) {
      const abs = path.resolve(input.path);
      if (p.neverAnalyzeFiles.some((f) => path.resolve(f) === abs))
        return { allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' };
      if (p.neverAnalyzeDirs.some((d) => isInside(d, abs)))
        return { allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' };
    }
    return { allowed: true, status: null, reason: null };
  }
}
