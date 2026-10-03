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

export interface SecretServiceDeps {
  file: string;
  cipher: SecretCipher;
  logger: Logger;
}

/** Stores the LLM API key only encrypted (OS credential store via safeStorage); never in plain text in config or logs. */
export class SecretService {
  /** undefined until the key file was read once */
  private cache: string | null | undefined;

  private readonly file: string;
  private readonly cipher: SecretCipher;
  private readonly logger: Logger;

  constructor(deps: SecretServiceDeps) {
    ({ file: this.file, cipher: this.cipher, logger: this.logger } = deps);
    const { logger } = deps;
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
    const fromEnvironment = process.env.ARCHIVIST_LLM_API_KEY;
    if (fromEnvironment) return fromEnvironment;
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
    const temporaryFile = `${this.file}.tmp`;
    fs.writeFileSync(temporaryFile, this.cipher.encrypt(key), { mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
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
