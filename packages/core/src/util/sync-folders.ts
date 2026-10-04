const SEPARATOR = /[\\/]/;

const PROVIDERS: Array<{ name: string; matches: (segment: string) => boolean }> = [
  { name: 'OneDrive', matches: (segment) => /^onedrive($|\s|-)/.test(segment) },
  { name: 'Dropbox', matches: (segment) => /^dropbox($|\s|-)/.test(segment) },
  { name: 'iCloud Drive', matches: (segment) => ['icloud drive', 'iclouddrive', 'mobile documents', 'com~apple~clouddocs'].includes(segment) },
  { name: 'Google Drive', matches: (segment) => /^google ?drive($|\s|-)/.test(segment) || ['my drive', 'meine ablage'].includes(segment) },
];

/** Name of the cloud-sync service whose folder holds `folder` (recognised by the usual folder names), or null. */
export function detectSyncFolder(folder: string): string | null {
  const segments = folder
    .split(SEPARATOR)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  for (const provider of PROVIDERS) if (segments.some((segment) => provider.matches(segment))) return provider.name;
  return null;
}
