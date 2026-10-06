import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FetchLike } from '../../agent/adapters/common';
import { AppError } from '../../util/errors';
import { fileUrl, totalBytes, type SpeechModelFile, type SpeechModelSpec } from './model-manifest';

export interface InstallOptions {
  signal: AbortSignal;
  /** Bytes received so far over all files. */
  onProgress: (receivedBytes: number) => void;
}

/** The DOM and the Node typings of a fetch body differ between the projects that compile this file; at runtime they are the same stream. */
const toNodeStream = (body: unknown) => Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

const downloadFailed = (cause: unknown) =>
  new AppError('network_error', 'Der Download des Spracherkennungsmodells ist fehlgeschlagen. Prüfe deine Internetverbindung und versuche es noch einmal.', {
    retryable: true,
    cause,
    details: cause instanceof Error ? cause.message : undefined,
  });

/** The speech model on disk: complete or absent, never half there. Files are checked against pinned size and SHA-256 before they replace anything. */
export class SpeechModelStore {
  constructor(
    private readonly spec: SpeechModelSpec,
    private readonly modelsDir: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  get directory(): string {
    return path.join(this.modelsDir, this.spec.directory);
  }

  /** Cheap check on every status read: all files there with the pinned size. */
  isInstalled(): boolean {
    if (this.spec.files.length === 0) return false;
    return this.spec.files.every((file) => {
      try {
        return fs.statSync(path.join(this.directory, ...file.path.split('/'))).size === file.bytes;
      } catch {
        return false;
      }
    });
  }

  async install({ signal, onProgress }: InstallOptions): Promise<void> {
    const partial = `${this.directory}.partial`;
    await fsp.rm(partial, { recursive: true, force: true });
    try {
      let received = 0;
      const count = (bytes: number) => {
        received += bytes;
        onProgress(received);
      };
      for (const file of this.spec.files) await this.download(file, path.join(partial, ...file.path.split('/')), signal, count);
      await fsp.rm(this.directory, { recursive: true, force: true });
      await fsp.rename(partial, this.directory);
    } catch (err) {
      await fsp.rm(partial, { recursive: true, force: true });
      throw err;
    }
  }

  /** Deletes the model from the disk; it can be downloaded again. */
  async remove(): Promise<void> {
    await fsp.rm(this.directory, { recursive: true, force: true });
  }

  /** Total download size, for the progress display. */
  get totalBytes(): number {
    return totalBytes(this.spec);
  }

  private async download(file: SpeechModelFile, target: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<void> {
    const response = await this.fetchImpl(fileUrl(this.spec, file), { signal }).catch((err: unknown) => {
      throw signal.aborted ? err : downloadFailed(err);
    });
    if (!response.ok || !response.body) throw downloadFailed(new Error(`HTTP ${response.status} für ${file.path}`));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        size += chunk.length;
        onBytes(chunk.length);
        done(null, chunk);
      },
    });
    await pipeline(toNodeStream(response.body), meter, fs.createWriteStream(target), { signal }).catch((err: unknown) => {
      throw signal.aborted ? err : downloadFailed(err);
    });
    if (size !== file.bytes || hash.digest('hex') !== file.sha256) {
      throw new AppError('network_error', `Die heruntergeladene Datei ${file.path} ist beschädigt oder verändert. Sie wurde verworfen.`, {
        retryable: true,
        details: `erwartet ${file.bytes} Bytes, erhalten ${size}`,
      });
    }
  }
}
