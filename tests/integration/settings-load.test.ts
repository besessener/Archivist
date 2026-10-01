import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/harness';

describe('startup with an invalid settings.json (Issue #57)', () => {
  it('creates a notification once the notification service exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-settings-start-'));
    const config = path.join(root, 'Archivist', 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, 'settings.json'),
      JSON.stringify({ setupCompleted: true, privacy: { llmMode: 'local_only' }, ocr: { languages: 'deutsch' } }),
    );
    const app = await createTestApp({ dataRoot: root, configured: false });
    try {
      expect(app.services.settings.get().privacy.llmMode).toBe('local_only');
      const [n] = app.services.notifications.list();
      expect(n?.title).toBe('Ungültige Einstellungen zurückgesetzt');
      expect(n?.description).toContain('ocr.languages');
      expect(n?.priority).toBe('high');
    } finally {
      await app.cleanup();
    }
  });
});
