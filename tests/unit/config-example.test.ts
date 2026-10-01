import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings } from '@archivist/shared';

describe('Beispielkonfiguration', () => {
  it('ist gültig, enthält keine Zugangsdaten und hält Datenschutz-Standards ein', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../config.example.json'), 'utf8');
    const parsed = Settings.parse(JSON.parse(raw));
    expect(parsed.scan.enabled).toBe(false);
    expect(parsed.privacy.llmMode).toBe('confirm');
    expect(raw).not.toMatch(/api[-_]?key|sk-[A-Za-z0-9]|secret|password/i);
  });
});
