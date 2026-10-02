/** Only plain http(s) web pages may leave the app window – to the system browser (e.g. sources of a web search). */
export function isExternalWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hostname.includes('.');
  } catch {
    return false;
  }
}
