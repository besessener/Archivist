import fs from 'node:fs';
import path from 'node:path';
import type { LlmStatus } from '@archivist/shared';
import type { SettingsService } from './settings';

export interface PrivacyDecision {
  /** May content be sent to the external LLM endpoint? */
  allowed: boolean;
  /** Status for the UI if not allowed */
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

/** realpath of the deepest existing ancestor plus the non-existing rest (synchronous variant). */
function realpathDeepestSync(pathApi: PathApi, target: string): string | null {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return pathApi.join(fs.realpathSync.native(current), ...rest.toReversed());
    } catch {
      const parent = pathApi.dirname(current);
      if (parent === current) return null;
      rest.push(pathApi.basename(current));
      current = parent;
    }
  }
}

/** Compares paths like the file system: lexical and real path (symlinks, junctions) both count, case-insensitive on Windows. */
export class PathMatcher {
  private readonly pathApi: PathApi;
  private readonly foldCase: boolean;

  constructor(private readonly platform: string = process.platform) {
    this.pathApi = platform === 'win32' ? path.win32 : path.posix;
    // Windows file systems are case-insensitive
    this.foldCase = platform === 'win32';
  }

  /** All spellings under which `target` is reachable (resolved and – if it exists on this machine – real path). */
  variants(target: string): string[] {
    const resolved = this.pathApi.resolve(target);
    const spellings = new Set([resolved]);
    // Real paths can only be determined for paths of the running platform.
    if (this.platform === process.platform) {
      const real = realpathDeepestSync(this.pathApi, resolved);
      if (real) spellings.add(real);
    }
    return [...spellings].map((spelling) => (this.foldCase ? spelling.toLowerCase() : spelling));
  }

  private insideLexically(root: string, candidate: string): boolean {
    const relative = this.pathApi.relative(root, candidate);
    return !(relative === '..' || relative.startsWith(`..${this.pathApi.sep}`) || this.pathApi.isAbsolute(relative));
  }

  /** true if `a` and `b` denote the same file. */
  same(a: string, b: string): boolean {
    const variantsOfB = this.variants(b);
    return this.variants(a).some((variant) => variantsOfB.includes(variant));
  }

  /** true if `candidate` equals `root` or lies below it. */
  inside(root: string, candidate: string): boolean {
    const rootVariants = this.variants(root);
    return this.variants(candidate).some((variant) => rootVariants.some((rootVariant) => this.insideLexically(rootVariant, variant)));
  }
}

/** Rules on whether and which content may be transmitted to the LLM (privacy gate). */
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
    const privacy = this.settings.get().privacy;
    if (privacy.llmMode === 'local_only') return { allowed: false, status: 'local_only', reason: 'Datenschutzmodus „nur lokal“ ist aktiv.' };
    if (input.docExcluded) return { allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' };
    if (input.rootLlmAllowed === false) return { allowed: false, status: 'excluded', reason: 'Das Scan-Verzeichnis ist von der LLM-Analyse ausgeschlossen.' };
    const ext = input.ext.toLowerCase().replace(/^\./, '');
    if (privacy.neverAnalyzeExtensions.some((excluded) => excluded.toLowerCase().replace(/^\./, '') === ext))
      return { allowed: false, status: 'excluded', reason: `Dateityp .${ext} wird nie extern analysiert.` };
    if (input.path) {
      const file = input.path;
      if (privacy.neverAnalyzeFiles.some((excluded) => this.paths.same(excluded, file)))
        return { allowed: false, status: 'excluded', reason: 'Datei ist von der externen Analyse ausgeschlossen.' };
      if (privacy.neverAnalyzeDirs.some((excluded) => this.paths.inside(excluded, file)))
        return { allowed: false, status: 'excluded', reason: 'Verzeichnis ist von der externen Analyse ausgeschlossen.' };
    }
    return { allowed: true, status: null, reason: null };
  }

  /** Gate for a stored document: per-document exclusion, folder permission, file type and path exclusions. */
  evaluateDocument(document: DocumentPrivacyFields): PrivacyDecision {
    return this.evaluate({
      path: document.sourcePath,
      ext: document.ext,
      docExcluded: document.llmStatus === 'excluded',
      rootLlmAllowed: document.folderLlmAllowed,
    });
  }

  /** May an analysed document go to the LLM without asking again? In „vorher fragen“ only released (`analyzed`) ones qualify. */
  mayShareDocument(document: DocumentPrivacyFields): boolean {
    if (!this.evaluateDocument(document).allowed) return false;
    return this.mode() === 'auto' || document.llmStatus === 'analyzed';
  }
}
