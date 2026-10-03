export type LlmBaseUrlCheck = { ok: true } | { ok: false; message: string };

const NOT_A_URL = 'Die Base URL muss eine vollständige Adresse sein, die mit https:// beginnt (z. B. https://…/v1).';
const INSECURE =
  'Unverschlüsseltes http:// ist nur für localhost erlaubt, weil dein API-Schlüssel und deine Dokumente sonst im Klartext durchs Netz gehen. Verwende https://.';

const LOOPBACK_IPV4 = /^127\.\d+\.\d+\.\d+$/;

/** The URL parser has already normalised the host (case, `127.1`, `0x7f.1`, `[0:0:0:0:0:0:0:1]`), so exact matches suffice. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return host === 'localhost' || host === '[::1]' || LOOPBACK_IPV4.test(host);
}

/** An empty value (not configured) and https:// pass; http:// only for the loopback host; everything else is refused with a German reason. */
export function checkLlmBaseUrl(value: string): LlmBaseUrlCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: NOT_A_URL };
  }
  if (url.protocol === 'https:') return { ok: true };
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname) ? { ok: true } : { ok: false, message: INSECURE };
  return { ok: false, message: NOT_A_URL };
}
