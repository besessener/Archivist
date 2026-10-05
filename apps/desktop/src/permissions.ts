/** What Chromium tells the permission handlers about a request or check; `requestingUrl` and `origin` name the page that asks. */
export interface PermissionContext {
  /** The page that asks (`app://archivist/chat/`, or its origin). */
  origin: string;
  /** The window that asks is Archivist's main window. */
  fromMainWindow: boolean;
  /** Origins of Archivist's own pages: `app://archivist`, plus the dev server in development. */
  trustedOrigins: string[];
}

const fromTrustedPage = ({ origin, fromMainWindow, trustedOrigins }: PermissionContext): boolean =>
  fromMainWindow && trustedOrigins.some((trusted) => origin === trusted || origin.startsWith(`${trusted}/`));

/** The one permission Archivist grants: the microphone (and nothing else, not the camera either), to its own page. */
export function allowsMicrophoneRequest({ permission, mediaTypes, ...context }: PermissionContext & { permission: string; mediaTypes?: string[] }): boolean {
  return permission === 'media' && mediaTypes?.length === 1 && mediaTypes[0] === 'audio' && fromTrustedPage(context);
}

export function allowsMicrophoneCheck({ permission, mediaType, ...context }: PermissionContext & { permission: string; mediaType?: string }): boolean {
  return permission === 'media' && mediaType === 'audio' && fromTrustedPage(context);
}
