import { nameSimilarity, normalizeName } from '../../util/text';

const VERSION_TOKEN_RE =
  /^(?:final|finale|endfassung|kopie|copy|neu|alt|entwurf|draft|v\d{1,3}|version|rev\d{0,3}|korr|korrigiert|aktuell|überarbeitet|ueberarbeitet)$/;
const DATE_IN_NAME_RE = /\b(?:\d{4}[-_.]\d{2}[-_.]\d{2}|\d{2}[-_.]\d{2}[-_.]\d{4}|\d{8})\b/g;

/** Name without version markers (final, v2, Kopie, (1), Entwurf …) and dates; `marker`: a non-date marker was there. */
export function versionKey(name: string): { key: string; marker: boolean; dates: string[] } {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '');
  const dates = [...base.matchAll(DATE_IN_NAME_RE)].map((m) => m[0].replace(/\D/g, ''));
  let marker = /\(\d{1,3}\)|\bversion\s?\d/i.test(base);
  const tokens = normalizeName(
    base
      .replace(DATE_IN_NAME_RE, ' ')
      .replace(/\(\d{1,3}\)/g, ' ')
      .replace(/\bversion\s?\d{1,3}\b/gi, ' '),
  )
    .split(' ')
    .filter((token) => {
      if (!VERSION_TOKEN_RE.test(token)) return true;
      marker = true;
      return false;
    });
  return { key: tokens.join(' '), marker, dates };
}

/** Two names are versions of each other: same key, similar titles, and not just two dated issues of a series. */
export function looksLikeVersions(a: { name: string; title: string }, b: { name: string; title: string }): boolean {
  const keyA = versionKey(a.name);
  const keyB = versionKey(b.name);
  if (!keyA.key || keyA.key !== keyB.key) return false;
  // titles are compared without their version markers as well („Plan Entwurf“ ~ „Plan final“)
  const titleA = versionKey(a.title).key || a.title;
  const titleB = versionKey(b.title).key || b.title;
  if (Math.max(nameSimilarity(a.title, b.title), nameSimilarity(titleA, titleB)) < 0.75) return false;
  const differentDates = keyA.dates.length > 0 && keyB.dates.length > 0 && keyA.dates.join() !== keyB.dates.join();
  return !(differentDates && !keyA.marker && !keyB.marker);
}
