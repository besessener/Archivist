import { SUPPORTED_EXTENSIONS } from '@archivist/shared';
import { isForbiddenScanRoot, isInside, normalizeFsPath } from '../util/paths';
import type { DocumentDeps } from './document-model';

const OWN_FOLDER_REFUSAL =
  'Archivists eigene Ordner (Datenordner, Archiv, Eingang, Quarantäne, Papierkorb) können nicht importiert werden – sie enthalten schon Archivists eigene Kopien.';

/** Folders Archivist keeps its own copies in; a folder import neither starts in nor walks into them. */
export function ownFolders(deps: Pick<DocumentDeps, 'ctx' | 'settings'>): string[] {
  const { root, appData, inbox, quarantine, trash } = deps.ctx.paths;
  return [root, appData, inbox, quarantine, trash, deps.settings.get().archiveRoot].map((folder) => normalizeFsPath(folder));
}

/** Why a dropped folder is refused (system folder or one of Archivist's own), or null if it may be imported. */
export function folderRefusal(folder: string, deps: Pick<DocumentDeps, 'ctx' | 'settings'>): string | null {
  const forbidden = isForbiddenScanRoot(folder);
  if (forbidden) return forbidden.replace('gescannt', 'importiert');
  const real = normalizeFsPath(folder);
  return ownFolders(deps).some((own) => isInside(own, real)) ? OWN_FOLDER_REFUSAL : null;
}

/** What the walk of a folder import skips: Archivist's own folders and everything the privacy settings exclude from analysis. */
export function importWalkRules(deps: Pick<DocumentDeps, 'ctx' | 'settings'>): { excludedDirs: string[]; excludedFiles: string[]; extensions: string[] } {
  const { neverAnalyzeDirs, neverAnalyzeFiles, neverAnalyzeExtensions } = deps.settings.get().privacy;
  const never = new Set(neverAnalyzeExtensions.map((extension) => extension.toLowerCase().replace(/^\*?\./, '')));
  return {
    excludedDirs: [...ownFolders(deps), ...neverAnalyzeDirs],
    excludedFiles: neverAnalyzeFiles,
    extensions: SUPPORTED_EXTENSIONS.filter((extension) => !never.has(extension)),
  };
}
