import type { DocumentRecord } from '@archivist/shared';
import { MIME_BY_EXT } from '../../../parsers';
import { truncate } from '../../../util/text';
import { ARCHIVED } from '../common';

const READABLE_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'markdown', 'eml', 'png', 'jpg', 'jpeg']);

type ProblemFields = Pick<DocumentRecord, 'status' | 'processingError' | 'ext' | 'mime' | 'textLength' | 'processingStatus'>;

function processingReasons(d: ProblemFields): string[] {
  const reasons: string[] = [];
  const error = d.processingError ?? '';
  if (/passwor|password|verschlüssel|encrypt/i.test(error))
    reasons.push('Die Datei ist vermutlich verschlüsselt bzw. passwortgeschützt – ohne Passwort lässt sich kein Text lesen.');
  if (d.status === 'quarantined') reasons.push('In Quarantäne: Der Inhalt passt nicht zur Dateiendung. Die Datei wurde weder gelesen noch analysiert.');
  else if (d.status === 'failed') reasons.push(`Verarbeitung fehlgeschlagen${error ? `: ${truncate(error, 160)}` : ''} – „Erneut verarbeiten“ versuchen.`);
  else if (error && !reasons.length) reasons.push(`Hinweis bei der Verarbeitung: ${truncate(error, 160)}`);
  return reasons;
}

/** Plain-language explanation of what is wrong with a document (empty: nothing). */
export function problemReasons(d: ProblemFields): string[] {
  const reasons = processingReasons(d);
  const expected = MIME_BY_EXT[d.ext.toLowerCase()];
  if (expected && d.mime && d.mime !== expected && d.mime !== 'application/octet-stream')
    reasons.push(`Endung .${d.ext} passt nicht zum Dateityp (${d.mime}).`);
  if (ARCHIVED.includes(d.status) && READABLE_EXT.has(d.ext.toLowerCase()) && d.textLength === 0)
    reasons.push('Kein Text erkannt, obwohl der Dateityp lesbar ist – vermutlich ein Scan ohne Texterkennung oder eine leere bzw. beschädigte Datei.');
  return reasons;
}
