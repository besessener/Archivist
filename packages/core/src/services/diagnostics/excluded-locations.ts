import type { DocumentService } from '../documents';
import type { PrivacyService } from '../privacy';
import type { ScannerService } from '../scanner';
import type { SettingsService } from '../settings';

const MIN_PLACE_LENGTH = 3;

const normalize = (text: string) => text.replaceAll(/\\+/g, '/').toLowerCase();
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export type ExclusionCheck = (text: string) => boolean;

export type ExcludedLocationsDeps = { settings: SettingsService; privacy: PrivacyService; docs: DocumentService; scanner: ScannerService };

/** Text that names a file or folder the user kept away from the LLM (log lines, job errors) must not reach it either. */
export class ExcludedLocations {
  constructor(private readonly deps: ExcludedLocationsDeps) {}

  /** The check at this moment, so an exclusion made a moment ago counts; it errs towards withholding. */
  current(): ExclusionCheck {
    const { settings, privacy, docs, scanner } = this.deps;
    const rules = settings.get().privacy;
    const documentPlaces = docs
      .list({ limit: 50_000 })
      .filter((document) => !privacy.evaluateDocument(document).allowed)
      .flatMap((document) => [document.sourcePath, document.stagedPath, document.originalName]);
    const rootPlaces = scanner
      .listDirectories()
      .filter((root) => !root.llmAllowed)
      .map((root) => root.path);
    const places = [...rules.neverAnalyzeDirs, ...rules.neverAnalyzeFiles, ...rootPlaces, ...documentPlaces]
      .filter((place): place is string => typeof place === 'string' && place.length >= MIN_PLACE_LENGTH)
      .map(normalize);
    const extensions = rules.neverAnalyzeExtensions.map((extension) => extension.replace(/^\*?\./, '')).filter(Boolean);
    const extensionPattern = extensions.length ? new RegExp(String.raw`\.(?:${extensions.map(escapeRegExp).join('|')})(?![a-z0-9])`, 'i') : null;
    return (text) => {
      const haystack = normalize(text);
      return places.some((place) => haystack.includes(place)) || Boolean(extensionPattern?.test(text));
    };
  }
}
