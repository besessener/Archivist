import fs from 'node:fs';
import path from 'node:path';
import { permissionError } from '../util/errors';
import type { Logger } from '../util/logger';

/** Abstraction over Electron safeStorage (replaceable by a fake implementation in tests). */
export interface SecretCipher {
  isAvailable(): boolean;
  backend(): string;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * Stores the LLM API key in encrypted form only (operating system credential store via
 * Electron safeStorage). The key never appears in plain text in configuration files or logs.
 */
export class SecretService {
  private cache: string | null | undefined;

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly logger: Logger,
  ) {
    const key = this.getApiKey();
    if (key) logger.registerSecret(key);
  }

  status(): { available: boolean; backend: string } {
    return { available: this.cipher.isAvailable(), backend: this.cipher.backend() };
  }

  hasApiKey(): boolean {
    return Boolean(this.getApiKey());
  }

  getApiKey(): string | null {
    const fromEnv = process.env.ARCHIVIST_LLM_API_KEY;
    if (fromEnv) return fromEnv;
    if (this.cache !== undefined) return this.cache;
    try {
      const data = fs.readFileSync(this.file);
      this.cache = this.cipher.decrypt(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('secret', 'API key could not be decrypted');
      this.cache = null;
    }
    return this.cache;
  }

  setApiKey(apiKey: string): void {
    const key = apiKey.trim();
    if (!key) throw permissionError('Der API-Key darf nicht leer sein.');
    if (!this.cipher.isAvailable()) {
      throw permissionError('Der sichere Speicher des Betriebssystems ist nicht verfügbar. Der API-Key wird nicht im Klartext gespeichert.');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.cipher.encrypt(key), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = key;
    this.logger.registerSecret(key);
    this.logger.info('secret', 'API key saved');
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
    this.cache = null;
    this.logger.info('secret', 'API key deleted');
  }
}
