import type { OptionalParam } from './optional-params';

const OPENAI_HOST = /(^|\.)openai\.com$|\.azure\.(com|us|cn)$/i;

function isOpenAiHost(baseUrl: string): boolean {
  try {
    return OPENAI_HOST.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The thinking depth to send. OpenAI knows no „max“ (its highest is „xhigh“); other endpoints get what was chosen.
 * Depths an endpoint rejected step down: max → xhigh → high. „none“ is sent as such, only null (the model's default) is left out.
 */
export function effectiveEffort(requested: string | null, { baseUrl, rejected }: { baseUrl: string; rejected: Set<OptionalParam> }): string | null {
  let effort = requested === 'max' && isOpenAiHost(baseUrl) ? 'xhigh' : requested;
  if (effort === 'max' && rejected.has('effort_max')) effort = 'xhigh';
  if (effort === 'xhigh' && rejected.has('effort_xhigh')) effort = 'high';
  return effort;
}

/** Notes for the transmission log: every way the request differs from what was asked, so a fallback is never silent. */
export function degradationNotes(wanted: { jsonSchema: boolean; effort: string | null }, sent: { body: Record<string, unknown> }): string[] {
  const notes: string[] = [];
  const format = (sent.body.text as { format?: { type?: string } } | undefined)?.format?.type;
  if (wanted.jsonSchema && format && format !== 'json_schema') notes.push('Der Endpunkt lehnt json_schema ab: JSON-Modus (json_object) verwendet.');
  if (wanted.jsonSchema && !format) notes.push('Der Endpunkt lehnt das Antwortformat ab: ohne Formatvorgabe gesendet.');
  const effort = (sent.body.reasoning as { effort?: string } | undefined)?.effort;
  const requested = wanted.effort;
  if (requested && requested !== 'none' && !effort) notes.push(`Der Endpunkt lehnt die Denktiefe ab: „${requested}“ weggelassen.`);
  else if (requested && effort && effort !== requested) notes.push(`Denktiefe „${requested}“ als „${effort}“ gesendet.`);
  return notes;
}
