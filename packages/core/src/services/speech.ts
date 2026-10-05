import type { SpeechStatus, SpeechTranscript } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError, permissionError } from '../util/errors';
import type { PrivacyService } from './privacy';
import { int16ToFloat32, isSilent, tidyTranscript } from './speech/audio';
import type { SpeechEngine } from './speech/engine';
import type { SpeechModelSpec } from './speech/model-manifest';
import type { SpeechModelStore } from './speech/model-store';

/** The window gets one progress update per 2 MB received. */
const PROGRESS_STEP_BYTES = 2 * 1024 * 1024;

interface Download {
  abort: AbortController;
  receivedBytes: number;
}

export interface SpeechServiceDeps {
  ctx: AppContext;
  privacy: PrivacyService;
  spec: SpeechModelSpec;
  store: SpeechModelStore;
  engine: SpeechEngine;
}

/** Speech input in the chat: a one-time model download and the local transcription of recordings. Audio is neither stored nor sent anywhere. */
export class SpeechService {
  private download: Download | null = null;
  private lastError: string | null = null;
  private transcribing = false;
  private readonly shutdown = new AbortController();

  constructor(private readonly deps: SpeechServiceDeps) {}

  status(): SpeechStatus {
    const { spec, store } = this.deps;
    const base = { modelLabel: spec.label, totalBytes: store.totalBytes, receivedBytes: 0, error: this.lastError };
    if (this.download) return { ...base, state: 'downloading', receivedBytes: this.download.receivedBytes };
    if (spec.files.length === 0) return { ...base, state: 'unavailable' };
    return { ...base, state: store.isInstalled() ? 'ready' : 'not_installed' };
  }

  /** Starts the download in the background; a second call while one runs changes nothing. */
  install(): SpeechStatus {
    const { privacy, store, ctx } = this.deps;
    const { state } = this.status();
    if (state === 'downloading' || state === 'ready') return this.status();
    if (state === 'unavailable') throw new AppError('validation_error', 'Diese Version von Archivist nennt kein Spracherkennungsmodell zum Herunterladen.');
    if (privacy.mode() === 'local_only') {
      throw permissionError('Im Datenschutzmodus „nur lokal“ lädt Archivist nichts aus dem Internet. Stelle den Modus für den Download kurz um.');
    }
    const download: Download = { abort: new AbortController(), receivedBytes: 0 };
    this.download = download;
    this.lastError = null;
    ctx.logger.info('speech', 'Model download started', { model: this.deps.spec.directory, bytes: store.totalBytes });
    void store
      .install({ signal: download.abort.signal, onProgress: (received) => this.report(download, received) })
      .then(() => ctx.logger.info('speech', 'Model installed', { model: this.deps.spec.directory }))
      .catch((err: unknown) => this.failed(download, err))
      .finally(() => {
        this.download = null;
        ctx.events.changed('speech');
      });
    ctx.events.changed('speech');
    return this.status();
  }

  cancelInstall(): SpeechStatus {
    this.download?.abort.abort();
    return this.status();
  }

  async transcribe(audio: Int16Array): Promise<SpeechTranscript> {
    if (!this.deps.store.isInstalled()) throw new AppError('validation_error', 'Die Spracheingabe ist noch nicht eingerichtet.');
    if (this.transcribing) throw new AppError('validation_error', 'Es wird gerade schon eine Aufnahme in Text umgewandelt.');
    const samples = int16ToFloat32(audio);
    if (isSilent(samples)) return { text: '' };
    this.transcribing = true;
    try {
      return { text: tidyTranscript(await this.deps.engine.transcribe(samples, this.shutdown.signal)) };
    } finally {
      this.transcribing = false;
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    this.download?.abort.abort();
    await this.deps.engine.close();
  }

  /** Progress arrives per chunk; the window needs it a few times a second at most. */
  private report(download: Download, received: number): void {
    const previous = download.receivedBytes;
    download.receivedBytes = received;
    if (Math.floor(received / PROGRESS_STEP_BYTES) !== Math.floor(previous / PROGRESS_STEP_BYTES)) this.deps.ctx.events.changed('speech');
  }

  private failed(download: Download, err: unknown): void {
    if (download.abort.signal.aborted) return;
    this.lastError = err instanceof AppError ? err.message : 'Der Download des Spracherkennungsmodells ist fehlgeschlagen.';
    this.deps.ctx.logger.warn('speech', 'Model download failed', { error: err });
  }
}
