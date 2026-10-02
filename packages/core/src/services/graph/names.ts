import { personNameKey } from '../../util/person-names';
import { normalizeName } from '../../util/text';

/** A name as stored: trimmed, inner whitespace collapsed to single spaces. */
export const collapseWhitespace = (name: string): string => name.trim().replace(/\s+/g, ' ');

/** Appends the names whose key is not yet known to `existing`, in order, each once. */
function appendNew(existing: string[], added: { names: string[]; keyOf: (name: string) => string; known: Set<string> }): string[] {
  const out = [...existing];
  for (const name of added.names) {
    const clean = collapseWhitespace(name);
    const key = added.keyOf(clean);
    if (!key || added.known.has(key)) continue;
    added.known.add(key);
    out.push(clean);
  }
  return out;
}

/** The entity's aliases plus those of `names` that are neither its name nor a known alias. */
export function mergeAliases(entity: { normalizedName: string; aliases: string[] }, names: string[]): string[] {
  const known = new Set([entity.normalizedName, ...entity.aliases.map(normalizeName)]);
  return appendNew(entity.aliases, { names, keyOf: normalizeName, known });
}

/** `existing` roles plus the added ones not known yet (case- and umlaut-insensitive). */
export function mergeRoles(existing: string[], added: string[]): string[] {
  return appendNew(existing, { names: added, keyOf: personNameKey, known: new Set(existing.map(personNameKey)) });
}

/** Replaces names of merged entities by the canonical target name and removes resulting duplicates. */
export function replaceNames(list: string[], replacement: { from: Set<string>; to: string }): string[] {
  const { from, to } = replacement;
  if (!list.some((name) => from.has(normalizeName(name)))) return list;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const listed of list) {
    const name = from.has(normalizeName(listed)) ? to : listed;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
