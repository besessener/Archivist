import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool } from '../registry';
import { affectedCount, unknownNote, type ToolDeps } from './common';
import { captureDevice } from './research/device-capture';
import { foreignLanguageReport } from './research/language-report';
import { fileMailThread, newMainCategory } from './research/mail-filing';
import { receiptPhotosReport } from './research/receipt-report';

/** Undo type of aliases the agent registered for a person. */
export const PERSON_ALIAS_UNDO = 'agent_person_alias';

interface PersonAliasUndoData {
  id: string;
  aliases: string[];
}

export function registerSpecialUndo(deps: Pick<ToolDeps, 'undo' | 'graph'>): void {
  deps.undo.register(PERSON_ALIAS_UNDO, {
    check: async (data) => (deps.graph.getEntity((data as PersonAliasUndoData).id) ? [] : ['Die Person existiert nicht mehr.']),
    run: async (data) => {
      const { id, aliases } = data as PersonAliasUndoData;
      for (const alias of aliases) deps.graph.removeAlias(id, alias);
      return `${aliases.length} Name(n) wieder entfernt.`;
    },
  });
}

/** Special tasks (#312): receipt photos, mail threads, devices and warranties, other languages, family members. */
export function specialTaskTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'match_receipt_photos',
      description:
        'Belegfotos (PNG/JPG mit erkanntem Text): schlägt je Foto den passenden Beleg, Vorgang bzw. das Projekt vor – nach Betrag, Datum und Händler, mit Fundstellen. Nur ein Vorschlag; mit set_metadata bzw. add_to_case zuordnen, wenn der Benutzer es will. Ohne Angabe: alle archivierten Bilder.',
      schema: z.object({ documents: list.nullish().describe('D…/S… der Fotos; leer = alle archivierten Bilder') }),
      risk: 'read',
      label: () => 'Ordne Belegfotos zu Rechnungen zu',
      run: (a, ctx) => receiptPhotosReport({ deps, ctx }, a.documents),
    }),
    defineTool({
      name: 'file_mail_thread',
      description:
        'Legt einen E-Mail-Verlauf (D…/S… aus email_threads) zusammen ab: die Nachrichten werden mit der ersten verknüpft (bestätigt) und in einen gemeinsamen Ordner verschoben. Rückgängig mit dem Lauf. Eine neue Hauptkategorie fragt immer nach.',
      schema: z.object({ documents: list, folder: z.string().min(1).describe('gemeinsamer Zielordner, z. B. "Privat/Korrespondenz/Angebot-Küche"') }),
      risk: (a) => (newMainCategory(deps, a.folder) ? 'critical' : 'write'),
      count: (a, ctx) => affectedCount(ctx, a.documents),
      label: (a) => `Lege einen E-Mail-Verlauf in ${a.folder} ab`,
      run: (a, ctx) => fileMailThread({ deps, ctx }, a),
    }),
    defineTool({
      name: 'capture_device',
      description:
        'Erfasst ein Gerät mit Beleg (D…): Seriennummer (aus dem Beleg oder angegeben, geprüft) und Garantieende als Notiz, verknüpft mit dem Beleg, plus eine Erinnerung am Garantieende. Garantieende: warrantyEnd, sonst Kaufdatum + warrantyMonths, sonst die im Beleg genannte Garantiezeit, sonst die gesetzlichen 24 Monate (als Annahme genannt). Gibt es für Beleg und Tag schon eine Erinnerung, wird keine zweite angelegt.',
      schema: z.object({
        device: z.string().min(1).describe('Name des Geräts, z. B. "Waschmaschine Bosch"'),
        receipt: z.string().min(1).describe('Beleg (D…)'),
        serialNumber: optText,
        warrantyEnd: optText.describe('Garantieende YYYY-MM-DD, falls bekannt'),
        warrantyMonths: z.coerce.number().int().min(1).max(240).nullish(),
      }),
      risk: 'write',
      label: (a) => `Erfasse das Gerät „${truncate(a.device, 40)}“ mit Garantie`,
      run: (a, ctx) => captureDevice({ deps, ctx }, { ...a, warrantyMonths: a.warrantyMonths ?? null }),
    }),
    defineTool({
      name: 'find_foreign_language_documents',
      description:
        'Listet archivierte Dokumente, die nicht auf Deutsch (bzw. language) geschrieben sind, mit erkannter Sprache (Deutsch, Englisch, Französisch, Spanisch, Italienisch). Die Sprache wird lokal aus häufigen Wörtern erkannt. Suchbegriffe in diesen Sprachen übersetzt du selbst und gibst sie bei search als alsoTry mit.',
      schema: z.object({
        documents: list.nullish().describe('D…/S…; leer = alle archivierten'),
        language: z.enum(['de', 'en', 'fr', 'es', 'it']).default('de'),
      }),
      risk: 'read',
      label: () => 'Suche fremdsprachige Dokumente',
      run: (a, ctx) => foreignLanguageReport({ deps, ctx }, a),
    }),
    defineTool({
      name: 'add_person_alias',
      description:
        'Merkt weitere Namen für eine bekannte Person (K…): Spitznamen oder Beziehungen („Tochter“, „meine Tochter“, „Opa“). Danach finden resolve_person und find_documents (person) die Person darüber. Nur auf Wunsch des Benutzers; ein Name, den schon eine andere Person trägt, wird nicht vergeben.',
      schema: z.object({ person: z.string().min(1), aliases: list }),
      risk: 'write',
      label: (a) => `Merke Namen für eine Person: ${truncate(a.aliases.join(', '), 50)}`,
      run: async (a, ctx) => {
        const id = ctx.refs.resolve(a.person);
        const person = id ? deps.graph.getEntity(id) : undefined;
        if (person?.type !== 'person') return { content: `„${a.person}“ ist keine bekannte Person.${unknownNote(id ? [] : [a.person])}`, isError: true };
        const added: string[] = [];
        const refused: string[] = [];
        for (const alias of a.aliases) {
          const owner = deps.persons.resolve(alias, { create: false }).entity;
          if (owner && owner.id !== person.id) refused.push(`„${alias}“ (gehört zu ${owner.name})`);
          else if (!owner) {
            deps.graph.addAlias(person.id, alias);
            added.push(alias);
          }
        }
        if (added.length)
          deps.audit.log({
            action: 'entity.alias',
            actor: 'agent',
            trigger: 'agent',
            confirmed: true,
            entityIds: [person.id],
            after: { aliases: added },
            undo: { type: PERSON_ALIAS_UNDO, data: { id: person.id, aliases: added } satisfies PersonAliasUndoData },
          });
        const change = `${person.name}: ${added.length ? `auch „${added.join('“, „')}“ gemerkt` : 'nichts Neues'}`;
        return {
          content: `${change}.${refused.length ? ` Nicht vergeben: ${refused.join(', ')}.` : ''}`,
          summary: added.length ? `${added.length} gemerkt` : 'nichts geändert',
          change: added.length ? change : undefined,
          isError: !added.length && refused.length > 0,
        };
      },
    }),
  ];
}
