// German messages for failed update steps; electron-updater marks known failures with an error `code`.

export type UpdateStep = 'check' | 'download' | 'install';

const NOT_PUBLISHED_YET = 'Die neueste Version ist auf GitHub noch nicht vollständig veröffentlicht. Versuche es später erneut.';

const KNOWN_FAILURES: ReadonlyMap<string, string> = new Map([
  ['ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', NOT_PUBLISHED_YET],
  ['ERR_UPDATER_ASSET_NOT_FOUND', NOT_PUBLISHED_YET],
  ['ERR_CHECKSUM_MISMATCH', 'Das heruntergeladene Update ist beschädigt und wurde verworfen. Versuche es später erneut.'],
  ['ERR_UPDATER_INVALID_SIGNATURE', 'Die Signatur des heruntergeladenen Updates passt nicht; es wurde verworfen.'],
  ['ENOSPC', 'Auf dem Datenträger ist nicht genug Platz für das Update. Gib Speicherplatz frei und versuche es erneut.'],
]);

const FALLBACKS: Readonly<Record<UpdateStep, string>> = {
  check: 'Die Suche nach Updates ist fehlgeschlagen. Prüfe deine Internetverbindung und versuche es später erneut.',
  download: 'Das Update konnte nicht heruntergeladen werden. Versuche es später erneut.',
  install: 'Das Update konnte nicht installiert werden. Starte Archivist neu und versuche es erneut.',
};

/** What the user reads when an update step failed; the cause itself goes to the log. */
export function updateFailureMessage(step: UpdateStep, error: unknown): string {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  return KNOWN_FAILURES.get(code) ?? FALLBACKS[step];
}
