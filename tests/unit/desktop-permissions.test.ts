import { describe, expect, it } from 'vitest';
import { allowsMicrophoneCheck, allowsMicrophoneRequest } from '../../apps/desktop/src/permissions';

const own = { origin: 'app://archivist/chat/', fromMainWindow: true, trustedOrigins: ['app://archivist'] };

describe('microphone permission', () => {
  it('grants the microphone to the main window', () => {
    expect(allowsMicrophoneRequest({ ...own, permission: 'media', mediaTypes: ['audio'] })).toBe(true);
    expect(allowsMicrophoneCheck({ ...own, permission: 'media', mediaType: 'audio' })).toBe(true);
  });

  it('accepts the bare origin as well as a page below it', () => {
    expect(allowsMicrophoneCheck({ ...own, origin: 'app://archivist', permission: 'media', mediaType: 'audio' })).toBe(true);
  });

  it('never grants the camera, alone or together with the microphone', () => {
    expect(allowsMicrophoneRequest({ ...own, permission: 'media', mediaTypes: ['video'] })).toBe(false);
    expect(allowsMicrophoneRequest({ ...own, permission: 'media', mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(allowsMicrophoneCheck({ ...own, permission: 'media', mediaType: 'video' })).toBe(false);
  });

  it('refuses a media request that names no type', () => {
    expect(allowsMicrophoneRequest({ ...own, permission: 'media' })).toBe(false);
    expect(allowsMicrophoneRequest({ ...own, permission: 'media', mediaTypes: [] })).toBe(false);
    expect(allowsMicrophoneCheck({ ...own, permission: 'media', mediaType: 'unknown' })).toBe(false);
  });

  it('keeps every other permission denied', () => {
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'display-capture', 'midi']) {
      expect(allowsMicrophoneRequest({ ...own, permission, mediaTypes: ['audio'] })).toBe(false);
      expect(allowsMicrophoneCheck({ ...own, permission, mediaType: 'audio' })).toBe(false);
    }
  });

  it('refuses pages that are not Archivist’s own, even one that merely starts like it', () => {
    for (const origin of ['https://example.com', 'app://archivist.evil.example/', 'app://other', '']) {
      expect(allowsMicrophoneRequest({ ...own, origin, permission: 'media', mediaTypes: ['audio'] })).toBe(false);
      expect(allowsMicrophoneCheck({ ...own, origin, permission: 'media', mediaType: 'audio' })).toBe(false);
    }
  });

  it('refuses any window but the main one', () => {
    expect(allowsMicrophoneRequest({ ...own, fromMainWindow: false, permission: 'media', mediaTypes: ['audio'] })).toBe(false);
    expect(allowsMicrophoneCheck({ ...own, fromMainWindow: false, permission: 'media', mediaType: 'audio' })).toBe(false);
  });

  it('trusts the dev server only when it is listed', () => {
    const dev = { ...own, origin: 'http://localhost:3000/chat/' };
    expect(allowsMicrophoneCheck({ ...dev, permission: 'media', mediaType: 'audio' })).toBe(false);
    expect(allowsMicrophoneCheck({ ...dev, trustedOrigins: ['app://archivist', 'http://localhost:3000'], permission: 'media', mediaType: 'audio' })).toBe(true);
  });
});
