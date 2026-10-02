import type { DocumentProposal } from '@archivist/shared';
import { normalizeDateInput, parseGermanDate } from '../util/dates';
import { firstSentence, nameSimilarity, normalizeName, tokenize, truncate } from '../util/text';
import { detectOpenItemSentences } from './open-items';

/** Local heuristics (without LLM) for document classification and target folders. */

export interface LocalClassification {
  docType: string;
  title: string;
  summary: string;
  categoryPath: string;
  topic: string | null;
  project: string | null;
  persons: string[];
  tags: string[];
  dates: string[];
  possibleOpenItems: DocumentProposal['possibleOpenItems'];
  possibleDecisions: DocumentProposal['possibleDecisions'];
  confidence: number;
  rationale: string;
}

const WORD_CHAR = String.raw`[\p{L}\p{N}]`;
/** Common German inflection endings a keyword may carry at the end of a word ("Dienstreisen", "Zahnarztes"). */
const INFLECTION = '(?:en|er|es|e|n|s)?';

/**
 * Builds a keyword test. A keyword matches
 * - at the start of a word ("Reise", "Reisekosten"), or
 * - as the final component of a compound whose preceding part has at least three letters ("Dienstreise",
 *   "Zahnarzt", "Arbeitsvertrag"), optionally inflected.
 * It never matches in the middle of a word ("Großflughafen") or after a short prefix ("Preise").
 * Letters and digits (including umlauts and ß) are word characters, so "_" or "-" in file names separate words.
 * Keywords containing regex syntax only match at the start of a word. `excludedEndings` lists compounds that
 * end in a keyword but mean something else ("Kaufpreise", "Umsatzsteuer").
 */
function keywordMatcher(keywords: string[], excludedEndings: string[] = []): (text: string) => boolean {
  const compoundable = keywords.filter((k) => /^\p{L}+$/u.test(k));
  const alternatives = [`(?<start>(?<!${WORD_CHAR})(?:${keywords.join('|')}))`];
  if (compoundable.length > 0) alternatives.push(`(?<=\\p{L}{3})(?:${compoundable.join('|')})${INFLECTION}(?!${WORD_CHAR})`);
  const re = new RegExp(alternatives.join('|'), 'giu');
  const excluded = excludedEndings.length > 0 ? new RegExp(`(?:${excludedEndings.join('|')})${INFLECTION}$`, 'iu') : null;
  return (text) => {
    for (const m of text.matchAll(re)) {
      if (m.groups?.start !== undefined || !excluded) return true;
      let wordStart = m.index;
      while (wordStart > 0 && /[\p{L}\p{N}]/u.test(text[wordStart - 1]!)) wordStart -= 1;
      if (!excluded.test(text.slice(wordStart, m.index + m[0].length))) return true;
    }
    return false;
  };
}

const RULES: Array<{ matches: (text: string) => boolean; path: (year: string) => string; type: string; weight: number }> = [
  {
    matches: keywordMatcher(['urlaub', 'reise', 'anreise', 'abreise', 'flug', 'hotel', 'buchungsbest'], ['preise', 'kreise']),
    path: (y) => `private/vacation/${y}`,
    type: 'Urlaub/Reise',
    weight: 0.7,
  },
  {
    matches: keywordMatcher(['steuer', 'finanzamt', 'steuererkl'], ['umsatzsteuer', 'mehrwertsteuer', 'vorsteuer']),
    path: (y) => `private/finance/taxes/${y}`,
    type: 'Steuerdokument',
    weight: 0.75,
  },
  { matches: keywordMatcher(['versicherung', 'police', 'schadenmeldung']), path: () => 'private/insurance', type: 'Versicherung', weight: 0.7 },
  {
    matches: keywordMatcher(['miete', 'mietvertrag', 'hauskauf', 'immobilie', 'nebenkosten', 'grundbuch', 'baufinanz']),
    path: () => 'private/housing',
    type: 'Wohnen',
    weight: 0.7,
  },
  {
    matches: keywordMatcher(['arzt', 'diagnose', 'rezept', 'krankenkasse', 'befund', 'gesundheit'], ['fehlerdiagnose', 'kochrezept', 'backrezept']),
    path: () => 'private/health',
    type: 'Gesundheit',
    weight: 0.7,
  },
  {
    matches: keywordMatcher(['protokoll', 'meeting', 'jour\\s?fixe', 'besprechung', 'agenda', 'teilnehmer']),
    path: (y) => `work/meetings/${y}`,
    type: 'Protokoll',
    weight: 0.65,
  },
  {
    matches: keywordMatcher(['vertrag', 'vereinbarung', 'kündigungsfrist', 'vertragspartner', 'auftragnehmer']),
    path: () => 'work/contracts',
    type: 'Vertrag',
    weight: 0.6,
  },
  {
    matches: keywordMatcher(['architektur', 'systemdesign', 'schnittstelle', 'komponenten', 'adr(?![\\p{L}\\p{N}])', 'technische\\s+konzept']),
    path: () => 'work/architecture',
    type: 'Architektur',
    weight: 0.6,
  },
  {
    matches: keywordMatcher(['rechnung', 'invoice', 'zahlungsziel', 'rechnungsnummer'], ['berechnung', 'hochrechnung', 'verrechnung']),
    path: (y) => `private/finance/invoices/${y}`,
    type: 'Rechnung',
    weight: 0.6,
  },
];

const TYPE_FOLDERS = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'txt',
  'md',
  'eml',
  'png',
  'jpg',
  'jpeg',
  'images',
  'bilder',
  'dateien',
  'files',
]);

/** Removes pure file-type folders and cryptic segments (hash/UUID) from a proposed path. */
export function humanizeCategoryPath(p: string): string {
  const segs = p
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter((s) => s && !TYPE_FOLDERS.has(s.toLowerCase()) && !/^[0-9a-f]{16,}$/i.test(s) && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s));
  return segs.join('/');
}

function docTypeFromExt(ext: string): string {
  switch (ext) {
    case 'pptx':
      return 'Präsentation';
    case 'xlsx':
      return 'Tabelle';
    case 'eml':
      return 'E-Mail';
    case 'png':
    case 'jpg':
    case 'jpeg':
      return 'Bild';
    default:
      return 'Dokument';
  }
}

export function extractDates(text: string, now = new Date()): string[] {
  const out = new Set<string>();
  const re =
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})\b|\b\d{1,2}\.\s?(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{4}\b/gi;
  for (const m of text.slice(0, 50_000).matchAll(re)) {
    const iso = parseGermanDate(m[0], now);
    if (iso) out.add(iso);
    if (out.size >= 10) break;
  }
  return [...out];
}

export function keywordTags(text: string, max = 5): string[] {
  const freq = new Map<string, number>();
  for (const t of tokenize(text.slice(0, 20_000))) if (t.length > 4 && !/^\d+$/.test(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

/** Finds known topics/projects that occur in the text. */
export function matchKnownNames(text: string, names: string[]): string | null {
  const norm = ` ${normalizeName(text.slice(0, 30_000))} `;
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    const n = normalizeName(name);
    if (n.length < 3) continue;
    if (norm.includes(` ${n} `)) {
      const score = n.length;
      if (!best || score > best.score) best = { name, score };
    }
  }
  return best?.name ?? null;
}

export function classifyLocally(input: {
  fileName: string;
  ext: string;
  text: string;
  knownTopics: string[];
  knownProjects: string[];
  now?: Date;
}): LocalClassification {
  const now = input.now ?? new Date();
  const base = input.fileName.replace(/\.[^.]+$/, '').replace(/_+/g, ' ');
  const hay = `${input.fileName}\n${input.text.slice(0, 20_000)}`;
  const dates = extractDates(input.text, now);
  const year = (dates.find((d) => d.startsWith(String(now.getFullYear()))) ?? dates[0] ?? String(now.getFullYear())).slice(0, 4);
  const project = matchKnownNames(hay, input.knownProjects);
  const topic = matchKnownNames(hay, input.knownTopics) ?? project;
  const rule = RULES.find((r) => r.matches(hay));
  let categoryPath: string;
  let docType = docTypeFromExt(input.ext);
  let confidence: number;
  let rationale: string;
  if (project) {
    categoryPath = `work/projects/${project}`;
    docType = rule?.type ?? docType;
    confidence = 0.6;
    rationale = `Der Projektname „${project}“ kommt im Dokument vor.`;
  } else if (rule) {
    categoryPath = rule.path(year);
    docType = rule.type;
    confidence = rule.weight;
    rationale = `Typische Begriffe für „${rule.type}“ gefunden.`;
  } else {
    categoryPath = 'private/unsortiert';
    rationale = 'Keine eindeutigen Hinweise gefunden – bitte Zielordner prüfen.';
    confidence = 0.25;
  }
  const openItems = detectOpenItemSentences(input.text).map((s) => ({ title: truncate(s, 100), description: s, dueAt: null as string | null }));
  const decisionSentences = input.text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /(?:wir\s+haben\s+)?(?:beschlossen|entschieden)|beschluss:|entscheidung:/i.test(s) && s.length < 400)
    .slice(0, 5)
    .map((s) => ({ title: firstSentence(s, 90), decisionText: s.trim(), decidedAt: extractDates(s, now)[0] ?? null }));
  return {
    docType,
    title: base.trim() || input.fileName,
    summary: firstSentence(input.text || base, 220),
    categoryPath,
    topic,
    project,
    persons: [],
    tags: keywordTags(input.text),
    dates,
    possibleOpenItems: openItems,
    possibleDecisions: decisionSentences,
    confidence,
    rationale,
  };
}

/** Maps a name returned by the LLM to a known name (prevents duplicates like „ProdPlat“/„prod-plat“). */
export function snapToKnown(name: string | null | undefined, known: string[], threshold = 0.86): string | null {
  const clean = name?.trim();
  if (!clean) return null;
  let best: { n: string; s: number } | null = null;
  for (const k of known) {
    const s = nameSimilarity(clean, k);
    if (s >= threshold && (!best || s > best.s)) best = { n: k, s };
  }
  return best?.n ?? clean;
}

export const normalizeIsoDates = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.map((v) => normalizeDateInput(v ?? null)).filter((v): v is string => Boolean(v))),
];
