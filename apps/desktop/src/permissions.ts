import type { Session, WebContents } from 'electron';

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

/** The microphone (not the camera, alone or together with it), for Archivist's own page. */
export function allowsMicrophoneRequest({ permission, mediaTypes, ...context }: PermissionContext & { permission: string; mediaTypes?: string[] }): boolean {
  return permission === 'media' && mediaTypes?.length === 1 && mediaTypes[0] === 'audio' && fromTrustedPage(context);
}

export function allowsMicrophoneCheck({ permission, mediaType, ...context }: PermissionContext & { permission: string; mediaType?: string }): boolean {
  return permission === 'media' && mediaType === 'audio' && fromTrustedPage(context);
}

/** Writing to the clipboard (copying a chat answer); reading it stays denied, pasting needs no permission. */
export function allowsClipboardWrite({ permission, ...context }: PermissionContext & { permission: string }): boolean {
  return permission === 'clipboard-sanitized-write' && fromTrustedPage(context);
}

/** Denies every permission (camera, location, reading the clipboard …) except the microphone and clipboard writes for the main window's own pages. */
export function restrictPermissions(
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
  { trustedOrigins, isMainWindow }: { trustedOrigins: string[]; isMainWindow: (contents: WebContents | null) => boolean },
): void {
  session.setPermissionRequestHandler((contents, permission, respond, details) => {
    const context = { permission, origin: details.requestingUrl, fromMainWindow: isMainWindow(contents), trustedOrigins };
    respond(allowsMicrophoneRequest({ ...context, mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined }) || allowsClipboardWrite(context));
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const context = { permission, origin: requestingOrigin, fromMainWindow: isMainWindow(contents), trustedOrigins };
    return allowsMicrophoneCheck({ ...context, mediaType: details.mediaType }) || allowsClipboardWrite(context);
  });
}
