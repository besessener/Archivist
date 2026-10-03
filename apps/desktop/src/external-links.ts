/** Only plain http(s) web pages may leave the app window – to the system browser (e.g. sources of a web search). */
export function isExternalWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && parsed.hostname.includes('.');
  } catch {
    return false;
  }
}
