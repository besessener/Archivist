import { nameSimilarity, stripDiacritics } from './text';

// Parsing person mentions, the key that defines "the same person" and the classification of unclear pairs.

export interface ParsedPersonName {
  /** Trimmed input with collapsed whitespace. */
  raw: string;
  /** Display name without roles and titles in natural order ("Monika Lor-Zade"); empty if nothing name-like is left. */
  cleanName: string;
  /** Roles found in the input ("(chefin)", " – Führungskraft", ", Teamleiterin"), first letter capitalized. */
  roles: string[];
  /** Titles and salutations removed from the name ("Dr.", "Prof.", "Herr", "Frau"). */
  titles: string[];
  /** Equal keys mean the same person: case, hyphens, umlaut spellings, roles, titles and "Nachname, Vorname" are ignored. */
  comparisonKey: string;
}

/** Relation between two person names; `same` = equal comparison keys, everything else is unclear and must be asked. */
export type PersonNameRelation = 'same' | 'first_name_only' | 'last_name_only' | 'initial' | 'middle_name' | 'similar_spelling';

/** Minimum {@link nameSimilarity} of two comparison keys to count as a similar spelling ("Lorzadeh" ↔ "Lor-Zade"). */
const SIMILAR_SPELLING = 0.85;

const fold = (text: string): string =>
  stripDiacritics(text.normalize('NFC').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));

/** Comparison form of any name or word: lower case, umlauts as ae/oe/ue, ß as ss, only letters/digits, single spaces. */
export function personNameKey(text: string): string {
  return fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words that refer to the speaker; never a person name, but the own identity may resolve them (chat only). */
const SELF_REFERENCES = new Set(['ich', 'mir', 'mich', 'mein', 'meine', 'meiner', 'meinem', 'meinen', 'meins', 'selbst', 'ich selbst', 'me', 'myself']);

/** Pronouns and answer words that are never created as persons. Compared by {@link personNameKey}. */
const NOT_A_PERSON = new Set([
  ...SELF_REFERENCES,
  // pronouns and indefinite words
  'du', 'dir', 'dich', 'dein', 'deine', 'er', 'ihn', 'ihm', 'sie', 'ihr', 'ihnen', 'es', 'wir', 'uns', 'unser', 'unsere', 'euch', 'euer',
  'man', 'jemand', 'niemand', 'keiner', 'keine', 'kein', 'keins', 'alle', 'jeder', 'jede', 'wer', 'andere', 'sonst wer',
  'you', 'i', 'we', 'they', 'someone', 'somebody', 'anyone', 'nobody', 'everyone', 'none',
  // salutations without a name and answer words
  'herr', 'frau', 'ja', 'nein', 'jein', 'ok', 'okay', 'jo', 'noe', 'doch', 'genau', 'stimmt', 'richtig', 'falsch', 'vielleicht', 'egal', 'danke',
  'unbekannt', 'unklar', 'offen', 'noch offen', 'nicht bekannt', 'unbestimmt', 'keine ahnung', 'weiss nicht', 'weiss ich nicht',
  'spaeter', 'abbrechen', 'na', 'n a', 'null', 'tbd', 'todo', 'yes', 'no', 'unknown',
]); // prettier-ignore

/** Exact role words (folded) that may also appear without brackets ("Monika Chefin", ", Teamleiterin"). */
const ROLE_WORDS = new Set(
  `chef chefin leiter leiterin leitung teamleiter teamleiterin teamleitung abteilungsleiter abteilungsleiterin bereichsleiter bereichsleiterin
  projektleiter projektleiterin projektleitung gruppenleiter gruppenleiterin geschaeftsfuehrer geschaeftsfuehrerin geschaeftsfuehrung fuehrungskraft
  vorgesetzter vorgesetzte manager managerin projektmanager projektmanagerin ceo cto cfo coo cio vorstand vorstaendin kollege kollegin kunde kundin
  assistent assistentin assistenz sekretaer sekretaerin praktikant praktikantin werkstudent werkstudentin azubi berater beraterin entwickler
  entwicklerin architekt architektin admin administrator administratorin sachbearbeiter sachbearbeiterin referent referentin mitarbeiter
  mitarbeiterin ansprechpartner ansprechpartnerin teamlead inhaber inhaberin direktor direktorin praesident praesidentin vermieter vermieterin
  steuerberater steuerberaterin anwalt anwaeltin rechtsanwalt rechtsanwaeltin arzt aerztin hausarzt hausaerztin`.split(/\s+/),
);
/** Endings of compound role words ("Bereichsleiterin", "IT-Leiter") – only used to decide whether a comma part is a role. */
const ROLE_ENDINGS = ['leiter', 'leiterin', 'leitung', 'chef', 'chefin', 'manager', 'managerin', 'fuehrer', 'fuehrerin', 'fuehrungskraft', 'berater', 'beraterin', 'entwickler', 'entwicklerin', 'architekt', 'architektin', 'owner', 'lead', 'assistent', 'assistentin', 'referent', 'referentin', 'direktor', 'direktorin', 'mitarbeiter', 'mitarbeiterin']; // prettier-ignore

/** Salutations and academic titles; the abbreviations (hr., dipl., …) only count with a trailing period. */
const TITLE_WORDS = new Set(['herr', 'frau', 'dr', 'prof', 'professor', 'professorin', 'mr', 'mrs', 'ms']);
const TITLE_ABBREVIATIONS = new Set(['hr', 'fr', 'dipl', 'ing', 'mag', 'med', 'rer', 'nat', 'phil', 'jur', 'h c']);

function isTitle(token: string): boolean {
  if (/^(dr|dipl|prof)\.-?\p{L}+\.?$/iu.test(token)) return true; // Dr.-Ing., Dipl.-Kfm.
  const word = personNameKey(token);
  if (TITLE_WORDS.has(word)) return true;
  return token.endsWith('.') && TITLE_ABBREVIATIONS.has(word);
}

const isRoleWord = (token: string): boolean => ROLE_WORDS.has(personNameKey(token).replace(/ /g, ''));

/** True for text containing role words ("Chefin", "IT-Leiter", "Bereichsleiterin", "CEO"). */
function containsRoleWord(text: string): boolean {
  return text.split(' ').some((token) => {
    if (/^\p{Lu}{2,5}$/u.test(token)) return true; // acronyms: CEO, IT, HR
    const word = personNameKey(token).replace(/ /g, '');
    return ROLE_WORDS.has(word) || ROLE_ENDINGS.some((ending) => word.length > ending.length + 1 && word.endsWith(ending));
  });
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** Removes the given characters from both ends (a loop instead of a backtracking regex). */
function trimChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start += 1;
  while (end > start && chars.includes(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}
const trimPunctuation = (text: string): string => trimChars(text, ' \t,;:–—-');
const capitalize = (text: string): string => (text ? text[0]!.toLocaleUpperCase('de-DE') + text.slice(1) : text);

/** Removes leading titles; at least one name token is always kept. */
function stripTitles(part: string, titles: string[]): string {
  const tokens = part.split(' ').filter(Boolean);
  while (tokens.length > 1 && isTitle(tokens[0]!)) titles.push(tokens.shift()!);
  return tokens.join(' ');
}

function splitRoles(text: string): string[] {
  return text
    .split(/[,;/|&]/)
    .flatMap((role) => collapse(role).split(' und '))
    .map((role) => capitalize(trimPunctuation(collapse(role))))
    .filter((role) => personNameKey(role).length > 0);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = personNameKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Takes roles in brackets and after a spaced dash ("Monika Lor-Zade – Führungskraft"); a hyphen inside a name has no spaces. */
function takeMarkedRoles(text: string): { rest: string; roles: string[] } {
  const roles: string[] = [];
  let rest = text.replace(/[([{]([^()[\]{}]*)[)\]}]/g, (_match, inner: string) => {
    roles.push(...splitRoles(inner));
    return ' ';
  });
  rest = collapse(rest);
  const dash = /\s[–—-]\s/.exec(rest);
  if (dash) {
    roles.push(...splitRoles(rest.slice(dash.index + dash[0].length)));
    rest = rest.slice(0, dash.index);
  }
  return { rest, roles };
}

/** Reads a comma as "Nachname, Vorname" when a single word is followed by capitalized first names, else as "Name, Rolle". */
function resolveCommaParts(text: string): { name: string; roles: string[]; titles: string[] } {
  const parts = text
    .split(/[,;]/)
    .map((part) => trimPunctuation(part))
    .filter(Boolean);
  if (parts.length <= 1) return { name: parts[0] ?? '', roles: [], titles: [] };
  const titles: string[] = [];
  const last = stripTitles(parts[0]!, titles);
  const firstTitles: string[] = [];
  const first = stripTitles(parts[1]!, firstTitles);
  const firstTokens = first.split(' ');
  // a lower-case part after a capitalized name is a role ("Monika, chefin"); all lower case is just sloppy typing
  const lowerCaseRole = /^\p{Ll}/u.test(first) && !/^\p{Ll}/u.test(last);
  const reorder = last.split(' ').length === 1 && firstTokens.length <= 3 && !containsRoleWord(first) && !lowerCaseRole;
  if (reorder) return { name: `${first} ${last}`, roles: parts.slice(2).flatMap((part) => splitRoles(part)), titles: [...titles, ...firstTitles] };
  return { name: last, roles: parts.slice(1).flatMap((part) => splitRoles(part)), titles };
}

/** Parses a person mention ("Dr. Monika Lor-Zade (Chefin)", "Lor-Zade, Monika") into name, roles, titles and key. */
export function parsePersonName(input: string): ParsedPersonName {
  const raw = collapse(input);
  const marked = takeMarkedRoles(trimChars(raw, `"'„“”‚‘’»« `));
  const comma = resolveCommaParts(marked.rest);
  const roles = [...marked.roles, ...comma.roles];
  const titles = comma.titles;

  // titles in front of the name, role words around it ("Chefin Monika", "Monika Lor-Zade Teamleiterin")
  const tokens = stripTitles(collapse(comma.name), titles).split(' ').filter(Boolean);
  while (tokens.length > 1 && isRoleWord(tokens[tokens.length - 1]!)) roles.unshift(capitalize(tokens.pop()!));
  while (tokens.length > 1 && isRoleWord(tokens[0]!)) roles.unshift(capitalize(tokens.shift()!));
  const cleanName = trimPunctuation(tokens.join(' '));
  return { raw, cleanName, roles: dedupe(roles), titles, comparisonKey: personNameKey(cleanName) };
}

/** True for pronouns, answer words ("ja", "nein", "unbekannt") and text without letters: never a person. */
export function isNotAPersonName(input: string): boolean {
  const parsed = parsePersonName(input);
  const key = parsed.comparisonKey;
  if (!/\p{L}/u.test(key) || key.replace(/ /g, '').length < 2) return true;
  return NOT_A_PERSON.has(key) || NOT_A_PERSON.has(personNameKey(parsed.raw));
}

/** True for words meaning the speaker ("ich", "mir", "mich", "mein …"); see the self resolver of the person service. */
export function isSelfReference(input: string): boolean {
  return SELF_REFERENCES.has(personNameKey(input));
}

interface NameParts {
  key: string;
  /** Folded name parts; hyphenated names stay one part ("lorzade"). */
  parts: string[];
  /** Per part: the initial letter if the part is an initial ("M."), else null. */
  initials: Array<string | null>;
}

function nameParts(name: string): NameParts {
  const parsed = parsePersonName(name);
  const tokens = parsed.cleanName.split(' ').filter((token) => personNameKey(token));
  return {
    key: parsed.comparisonKey,
    parts: tokens.map((token) => personNameKey(token).replace(/ /g, '')),
    initials: tokens.map((token) => (/^\p{L}\.?$/u.test(token) ? personNameKey(token) : null)),
  };
}

/** `short` abbreviates `long` with at least one initial and otherwise equal parts, in order ("M. Lor-Zade"). */
function isInitialForm(short: NameParts, long: NameParts): boolean {
  if (!short.initials.some(Boolean) || short.parts.length < 2 || short.parts.length > long.parts.length) return false;
  if (short.parts[short.parts.length - 1] !== long.parts[long.parts.length - 1]) return false;
  let longIndex = 0;
  for (let shortIndex = 0; shortIndex < short.parts.length - 1; shortIndex += 1) {
    const initial = short.initials[shortIndex];
    const matches = (part: string) => (initial ? part.startsWith(initial) : part === short.parts[shortIndex]);
    while (longIndex < long.parts.length - 1 && !matches(long.parts[longIndex]!)) longIndex += 1;
    if (longIndex >= long.parts.length - 1) return false;
    longIndex += 1;
  }
  return true;
}

/** Every part of `short` occurs in `long`, each part used once. */
function partsContained(short: NameParts, long: NameParts): boolean {
  const rest = [...long.parts];
  return short.parts.every((part) => {
    const index = rest.indexOf(part);
    if (index < 0) return false;
    rest.splice(index, 1);
    return true;
  });
}

/** Which part a shorter name without initials keeps of a longer one; null if it is no part of it. */
function partialNameRelation(short: NameParts, long: NameParts): PersonNameRelation | null {
  if (short.parts.length >= long.parts.length || short.initials.some(Boolean) || !partsContained(short, long)) return null;
  const hasFirst = short.parts.includes(long.parts[0]!);
  const hasLast = short.parts.includes(long.parts[long.parts.length - 1]!);
  if (hasFirst && !hasLast) return 'first_name_only';
  if (hasLast && !hasFirst) return 'last_name_only';
  return 'middle_name';
}

/** `same` for an unambiguous duplicate, otherwise why two names might be the same person, or null. */
export function comparePersonNames(first: string, second: string): PersonNameRelation | null {
  const firstParts = nameParts(first);
  const secondParts = nameParts(second);
  if (!firstParts.key || !secondParts.key) return null;
  if (firstParts.key === secondParts.key) return 'same';
  if (isInitialForm(firstParts, secondParts) || isInitialForm(secondParts, firstParts)) return 'initial';
  const [short, long] = firstParts.parts.length <= secondParts.parts.length ? [firstParts, secondParts] : [secondParts, firstParts];
  const partial = partialNameRelation(short, long);
  if (partial) return partial;
  return nameSimilarity(firstParts.key, secondParts.key) >= SIMILAR_SPELLING ? 'similar_spelling' : null;
}
