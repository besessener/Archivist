import type { DocumentRecord } from '@archivist/shared';
import { normalizeName } from '../../util/text';
import { lower, type ToolDeps } from './common';

/**
 * Whether a document concerns the person a filter names: the mention goes through the person resolution (name, alias, nickname, „ich“ in the chat),
 * so „meine Tochter“ finds the documents of the person with that alias. A mention no person is known for stays a plain substring match.
 */
export function personFilter(deps: Pick<ToolDeps, 'persons'>, mention: string | null): (d: DocumentRecord) => boolean {
  if (!mention) return () => true;
  const { entity } = deps.persons.resolve(mention, { create: false, context: 'chat' });
  if (!entity) return (d) => d.persons.some((p) => lower(p).includes(mention.toLowerCase()));
  const names = new Set([entity.name, ...entity.aliases].map(normalizeName));
  return (d) => d.persons.some((p) => names.has(normalizeName(p)));
}
