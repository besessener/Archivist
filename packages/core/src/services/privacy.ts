import fs from 'node:fs';
import path from 'node:path';
import type { LlmStatus } from '@archivist/shared';
import type { SettingsService } from './settings';

export interface PrivacyDecision {
  /** Dürfen Inhalte an den externen LLM-Endpunkt gesendet werden? */
  allowed: boolean;
  /** Status für die UI, falls nicht erlaubt */
  status: Extract<LlmStatus, 'excluded' | 'local_only'> | null;
  reason: string | null;
}

/** The privacy-relevant fields of a stored document. */
export interface DocumentPrivacyFields {
  sourcePath: string | null;
  ext: string;
  llmStatus: string;
  /** false when the document lies in a scan folder without LLM permission */
  folderLlmAllowed: boolean;
}

type PathApi = typeof path.posix;

/** File systems on these platforms are case-insensitive by default. */
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<string> = new Set(['win32', 'darwin']);

/** realpath of the deepest existing ancestor plus the non-existing rest (synchronous variant). */
function realpathDeepestSync(pm: PathApi, target: string): string | null {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return pm.join(fs.realpathSync.native(current), ...rest.toReversed());
    } catch {
      const parent = pm.dirname(current);
      if (parent === current) return null;
      rest.push(pm.basename(current));
      current = parent;
    }
  }
}

/**
 * Compares paths like the file system does: both the lexical and the real path (symlinks, junctions) count,
 * and on Windows/macOS the comparison ignores case.
 */
export class PathMatcher {
  private readonly pm: PathApi;
  private readonly foldCase: boolean;

  constructor(private readonly platform: string = process.platform) {
    this.pm = platform === 'win32' ? path.win32 : path.posix;
    this.foldCase = CASE_INSENSITIVE_PLATFORMS.has(platform);
  }

  /** All spellings under which `p` is reachable (resolved and – if it exists on this machine – real path). */
  variants(p: string): string[] {
    const resolved = this.pm.resolve(p);
    const out = new Set([resolved]);
    // Real paths can only be determined for paths of the running platform.
    if (this.platform === process.platform) {
      const real = realpathDeepestSync(this.pm, resolved);
      if (real) out.add(real);
    }
    return [...out].map((v) => (this.foldCase ? v.toLowerCase() : v));
  }

  private insideLexically(root: string, candidate: string): boolean {
    const rel = this.pm.relative(root, candidate);
    if (rel === '') return true;
    return !(rel === '..' || rel.startsWith(`..${this.pm.sep}`) || this.pm.isAbsolute(rel));
  }

  /** true if `a` and `b` denote the same file. */
  same(a: string, b: string): boolean {
    const vb = this.variants(b);
    return this.variants(a).some((x) => vb.includes(x));
  }

  /** true if `candidate` equals `root` or lies below it. */
  inside(root: string, candidate: string): boolean {
    const vr = this.variants(root);
    return this.variants(candidate).some((c) => vr.some((r) => this.insideLexically(r, c)));
  }
}

/** Regeln, ob und welche Inhalte an das LLM übertragen werden dürfen (Datenschutz-Gate). */
export class PrivacyService {
  readonly paths: PathMatcher;

  constructor(
    private readonly settings: SettingsService,
    platform: string = process.platform,
  ) {
    this.paths = new PathMatcher(platform);
  }

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
      const file = input.path;
      if (p.neverAnalyzeFiles.some((f) => this.paths.same(f, file)))
        return { allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' };
      if (p.neverAnalyzeDirs.some((d) => this.paths.inside(d, file)))
        return { allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' };
    }
    return { allowed: true, status: null, reason: null };
  }

  /** Gate for a stored document: per-document exclusion, folder permission, file type and path exclusions. */
  evaluateDocument(d: DocumentPrivacyFields): PrivacyDecision {
    return this.evaluate({ path: d.sourcePath, ext: d.ext, docExcluded: d.llmStatus === 'excluded', rootLlmAllowed: d.folderLlmAllowed });
  }

  /**
   * May content of an already analyzed document be sent to the LLM *without asking again* (e.g. as a chat source)?
   * In mode „vorher fragen“ only documents the user released for external analysis (`llmStatus = analyzed`) qualify.
   */
  mayShareDocument(d: DocumentPrivacyFields): boolean {
    if (!this.evaluateDocument(d).allowed) return false;
    return this.mode() === 'auto' || d.llmStatus === 'analyzed';
  }
}
