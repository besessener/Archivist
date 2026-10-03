import { normalizeDateInput } from '../../../util/dates';
import { nowIso } from '../../../util/ids';
import type { ToolOutput } from '../../registry';
import { docLine, resolveDocs, unknownNote, type ToolScope } from '../common';
import { businessDate, documentText } from './access';
import { formatGermanDate } from './dates';
import { extractSerialNumber, LEGAL_WARRANTY, validateSerialNumber, warrantyFrom, warrantyPeriodIn, type Warranty } from './devices';

export interface DeviceArgs {
  device: string;
  receipt: string;
  serialNumber: string | null;
  warrantyEnd: string | null;
  warrantyMonths: number | null;
}

/** Warranty end as given, or purchase date + the period given, named in the receipt, else the legal two years. */
function warrantyOf(args: DeviceArgs, receipt: { text: string; purchaseDate: string }): Warranty | { error: string } {
  if (args.warrantyEnd) {
    const end = normalizeDateInput(args.warrantyEnd);
    return end
      ? { end, rechenweg: `Garantieende vom Benutzer genannt: ${formatGermanDate(end)}` }
      : { error: `Ungültiges Datum „${args.warrantyEnd}“ – erwartet YYYY-MM-DD.` };
  }
  if (args.warrantyMonths) return warrantyFrom(receipt.purchaseDate, { count: args.warrantyMonths, unit: 'monat' });
  const named = warrantyPeriodIn(receipt.text);
  const basis = named
    ? { period: named.period, note: `Beleg: „${named.line}“` }
    : { period: LEGAL_WARRANTY, note: 'Annahme: gesetzliche Gewährleistung, der Beleg nennt keine Garantiezeit' };
  const warranty = warrantyFrom(receipt.purchaseDate, basis.period);
  return { ...warranty, rechenweg: `${warranty.rechenweg} (${basis.note})` };
}

/** Stores a device as a note linked to its receipt and, while the warranty runs, one reminder at its end (no second one for the same receipt and day). */
export async function captureDevice(scope: ToolScope, args: DeviceArgs): Promise<ToolOutput> {
  const { deps, ctx } = scope;
  const { docs, unknown } = resolveDocs(scope, [args.receipt]);
  const receipt = docs[0];
  if (!receipt) return { content: `Unbekannte Dokument-ID „${args.receipt}“.${unknownNote(unknown)}`, isError: true };
  if (!deps.privacy.mayShareDocument(receipt))
    return { content: `${ctx.refs.doc(receipt.id)}: Der Beleg ist nicht zur Übertragung freigegeben – nichts gespeichert.`, isError: true };
  const text = documentText(deps, receipt.id);
  const serial = args.serialNumber ? validateSerialNumber(args.serialNumber) : (extractSerialNumber(text)?.serial ?? null);
  if (args.serialNumber && !serial)
    return {
      content: `„${args.serialNumber}“ ist keine gültige Seriennummer (5–30 Zeichen, Buchstaben, Ziffern, Bindestrich, mindestens eine Ziffer).`,
      isError: true,
    };
  const purchaseDate = businessDate(receipt).slice(0, 10);
  const warranty = warrantyOf(args, { text, purchaseDate });
  if ('error' in warranty) return { content: warranty.error, isError: true };

  const content = [
    `Gerät: ${args.device}`,
    `Seriennummer: ${serial ?? 'nicht angegeben'}`,
    `Kaufdatum: ${formatGermanDate(purchaseDate)} (Datum des Belegs)`,
    `Garantie bis: ${formatGermanDate(warranty.end)}`,
    `Rechenweg: ${warranty.rechenweg}`,
    `Beleg: ${receipt.title}`,
  ].join('\n');
  const { note, created } = await deps.notes.createUnlessExists({
    content,
    title: `Gerät: ${args.device}`,
    links: [{ targetId: receipt.id, relationType: 'relates_to' }],
  });
  if (created) deps.audit.log({ action: 'note.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [note.id] });

  const remindAt = warranty.end;
  const running = remindAt >= nowIso().slice(0, 10);
  const existing = deps.reminders.list('pending').find((r) => r.targetId === receipt.id && r.remindAt.slice(0, 10) === remindAt);
  let reminderLine = 'Keine Erinnerung angelegt: Die Garantie ist schon abgelaufen.';
  if (existing) reminderLine = `Erinnerung am ${remindAt} gab es schon – keine zweite angelegt.`;
  else if (running) {
    const reminder = deps.reminders.create({ targetType: 'document', targetId: receipt.id, title: `Garantie endet: ${args.device}`, remindAt });
    deps.audit.log({
      action: 'reminder.create',
      actor: 'agent',
      trigger: 'agent',
      confirmed: true,
      entityIds: [reminder.id],
      after: { title: reminder.title, remindAt },
    });
    reminderLine = `Erinnerung am ${remindAt} angelegt.`;
  }
  const change = `Gerät „${args.device}“ ${created ? 'erfasst' : 'war schon erfasst'} (Garantie bis ${formatGermanDate(warranty.end)})`;
  return {
    content: `${change}.\nNotiz ${ctx.refs.entry(note.id)}, verknüpft mit ${docLine(scope, receipt)}\n${content}\n${reminderLine}${serial ? '' : '\nHinweis: Auf dem Beleg wurde keine Seriennummer erkannt – frag den Benutzer danach.'}`,
    summary: `Garantie bis ${warranty.end}`,
    change,
  };
}
