import { isNotAPersonName, parsePersonName } from '../util/person-names';

const MAX_PERSONS = 15;
const SAMPLE_CHARS = 20_000;

/** Header lines that name people: attendee lists and the sender of a mail or letter (German and English). */
const PERSON_LINE =
  /^[ \t]*(?:teilnehmer(?:innen)?|teilnehmende|anwesend(?:e)?|attendees?|participants?|present|von|from|absender|sender|verfasser|autor|author)[ \t]*:[ \t]*(.+)$/gimu;

const NAME_PARTICLES = new Set(['von', 'van', 'de', 'der', 'zu', 'ten', 'ter', 'da', 'di']);

/** A name as written in a minute: 1 to 4 words, capitalized (or a particle), no digits. */
function looksLikePersonName(name: string): boolean {
  const words = name.split(' ');
  if (words.length > 4 || name.length > 40 || /\d/.test(name)) return false;
  return words.every((word) => /^\p{Lu}[\p{L}'.-]*$/u.test(word) || NAME_PARTICLES.has(word));
}

function namesOfLine(line: string): string[] {
  const withoutAddresses = line.replace(/<[^>]*>|\[[^\]]*\]/g, ' ');
  return withoutAddresses
    .split(/[;,]|\s+(?:und|and|&)\s+/)
    .map((part) => parsePersonName(part).cleanName)
    .filter((name) => name !== '' && !name.includes('@') && !isNotAPersonName(name) && looksLikePersonName(name));
}

/** People named on attendee and sender lines („Teilnehmer: Anna Berg, Ben Roth“, „From: Carla Neu <c@x.de>“); nothing is guessed from running text. */
export function personsInHeaderLines(text: string): string[] {
  const names = [...text.slice(0, SAMPLE_CHARS).matchAll(PERSON_LINE)].flatMap((match) => namesOfLine(match[1]!));
  return [...new Map(names.map((name) => [name.toLowerCase(), name])).values()].slice(0, MAX_PERSONS);
}

/** Folders that say where a file lies, not what it is about. */
const GENERIC_FOLDERS = new Set(
  'downloads download dokumente documents desktop schreibtisch inbox eingang temp tmp scans scan dateien files bilder pictures images home users user private work arbeit archiv archive onedrive dropbox nextcloud unsortiert neu new'.split(
    ' ',
  ),
);

/** A topic named by the folder a file came from („Hausbau Bern“), or null for generic, numeric or very short folder names. */
export function topicFromFolder(folderName: string): string | null {
  const name = folderName.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 3 || name.length > 60 || !/\p{L}{3}/u.test(name)) return null;
  return GENERIC_FOLDERS.has(name.toLowerCase()) ? null : name;
}
