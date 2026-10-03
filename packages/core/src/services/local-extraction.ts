import { isNotAPersonName, parsePersonName } from '../util/person-names';

const MAX_PERSONS = 15;
const SAMPLE_CHARS = 20_000;

/** Labels of header lines that name people: attendee lists and the sender of a mail or letter (German and English). */
const PERSON_LABELS = new Set(
  'teilnehmer teilnehmerinnen teilnehmende anwesend anwesende attendee attendees participant participants present von from absender sender verfasser autor author'.split(
    ' ',
  ),
);

const NAME_PARTICLES = new Set(['von', 'van', 'de', 'der', 'zu', 'ten', 'ter', 'da', 'di']);

/** A name as written in a minute: 1 to 4 words, capitalized (or a particle), no digits. */
function looksLikePersonName(name: string): boolean {
  const words = name.split(' ');
  if (words.length > 4 || name.length > 40 || /\d/.test(name)) return false;
  return words.every((word) => /^\p{Lu}[\p{L}'.-]{0,30}$/u.test(word) || NAME_PARTICLES.has(word));
}

function namesOfLine(line: string): string[] {
  const withoutAddresses = line.replace(/<[^>]{0,200}>|\[[^\]]{0,200}\]/g, ' ');
  return withoutAddresses
    .split(/[;,&]/)
    .flatMap((part) => part.split(' und '))
    .flatMap((part) => part.split(' and '))
    .map((part) => parsePersonName(part).cleanName)
    .filter((name) => name !== '' && !name.includes('@') && !isNotAPersonName(name) && looksLikePersonName(name));
}

/** The names after the label of a header line, or nothing for any other line. */
function namesOnLabelledLine(line: string): string[] {
  const colon = line.indexOf(':');
  if (colon < 0 || !PERSON_LABELS.has(line.slice(0, colon).trim().toLowerCase())) return [];
  return namesOfLine(line.slice(colon + 1));
}

/** People named on attendee and sender lines („Teilnehmer: Anna Berg, Ben Roth“, „From: Carla Neu <c@x.de>“); nothing is guessed from running text. */
export function personsInHeaderLines(text: string): string[] {
  const names = text.slice(0, SAMPLE_CHARS).split('\n').flatMap(namesOnLabelledLine);
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
