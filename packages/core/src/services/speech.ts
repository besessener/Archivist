import { SPEECH_MODEL_NAMES, type SpeechModelName, type SpeechStatus, type SpeechTranscript } from '@archivist/shared';
import type { AppContext } from '../context';
import { AppError, permissionError } from '../util/errors';
import type { PrivacyService } from './privacy';
import { int16ToFloat32, isSilent, tidyTranscript } from './speech/audio';
import type { SpeechEngine } from './speech/engine';
import type { SpeechModelSpec } from './speech/model-manifest';
import type { SpeechModelStore } from './speech/model-store';
import type { SettingsService } from './settings';

/** The window gets one progress update per 2 MB received. */
const PROGRESS_STEP_BYTES = 2 * 1024 * 1024;

interface Download {
  model: SpeechModelName;
  abort: AbortController;
  receivedBytes: number;
}

export interface SpeechModel {
  spec: SpeechModelSpec;
  store: SpeechModelStore;
}

export interface SpeechServiceDeps {
  ctx: AppContext;
  privacy: PrivacyService;
  settings: SettingsService;
  models: Record<SpeechModelName, SpeechModel>;
  engine: SpeechEngine;
}

/** Speech input in the chat: the one-time download of the chosen model and the local transcription of recordings. Audio is neither stored nor sent anywhere. */
export class SpeechService {
  private download: Download | null = null;
  private lastError: { model: SpeechModelName; message: string } | null = null;
  private transcribing = false;
  private readonly shutdown = new AbortController();

  constructor(private readonly deps: SpeechServiceDeps) {}

  private get selected(): SpeechModelName {
    return this.deps.settings.get().speech.model;
  }

  private stateOf(name: SpeechModelName): SpeechStatus['state'] {
    const { spec, store } = this.deps.models[name];
    if (this.download?.model === name) return 'downloading';
    if (spec.files.length === 0) return 'unavailable';
    return store.isInstalled() ? 'ready' : 'not_installed';
  }

  status(): SpeechStatus {
    const selected = this.selected;
    const { spec, store } = this.deps.models[selected];
    const download = this.download?.model === selected ? this.download : null;
    return {
      selected,
      state: this.stateOf(selected),
      modelLabel: spec.label,
      totalBytes: store.totalBytes,
      receivedBytes: download?.receivedBytes ?? 0,
      error: this.lastError?.model === selected ? this.lastError.message : null,
      models: SPEECH_MODEL_NAMES.map((name) => ({
        name,
        label: this.deps.models[name].spec.label,
        state: this.stateOf(name),
        totalBytes: this.deps.models[name].store.totalBytes,
      })),
    };
  }

  /** Starts the download of the chosen model in the background; a second call while it runs changes nothing. */
  install(): SpeechStatus {
    const { privacy, ctx } = this.deps;
    const model = this.selected;
    const state = this.stateOf(model);
    if (state === 'downloading' || state === 'ready') return this.status();
    if (state === 'unavailable') throw new AppError('validation_error', 'Diese Version von Archivist nennt für dieses Modell keinen Download.');
    if (this.download) throw new AppError('validation_error', 'Es läuft schon ein anderer Download. Warte, bis er fertig ist, oder brich ihn ab.');
    if (privacy.mode() === 'local_only') {
      throw permissionError('Im Datenschutzmodus „nur lokal“ lädt Archivist nichts aus dem Internet. Stelle den Modus für den Download kurz um.');
    }
    const { spec, store } = this.deps.models[model];
    const download: Download = { model, abort: new AbortController(), receivedBytes: 0 };
    this.download = download;
    this.lastError = null;
    ctx.logger.info('speech', 'Model download started', { model: spec.directory, bytes: store.totalBytes });
    void store
      .install({ signal: download.abort.signal, onProgress: (received) => this.trackProgress(download, received) })
      .then(() => ctx.logger.info('speech', 'Model installed', { model: spec.directory }))
      .catch((err: unknown) => this.recordFailure(download, err))
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

  /** Frees the disk space of a downloaded model; the one being downloaded stays. */
  async remove(model: SpeechModelName): Promise<SpeechStatus> {
    if (this.download?.model === model) throw new AppError('validation_error', 'Das Modell wird gerade heruntergeladen. Brich den Download zuerst ab.');
    await this.deps.models[model].store.remove();
    this.deps.ctx.logger.info('speech', 'Model removed', { model: this.deps.models[model].spec.directory });
    this.deps.ctx.events.changed('speech');
    return this.status();
  }

  async transcribe(audio: Int16Array): Promise<SpeechTranscript> {
    const { spec, store } = this.deps.models[this.selected];
    if (!store.isInstalled()) throw new AppError('validation_error', 'Die Spracheingabe ist noch nicht eingerichtet.');
    if (this.transcribing) throw new AppError('validation_error', 'Es wird gerade schon eine Aufnahme in Text umgewandelt.');
    const samples = int16ToFloat32(audio);
    if (isSilent(samples)) return { text: '' };
    this.transcribing = true;
    try {
      return { text: tidyTranscript(await this.deps.engine.transcribe(samples, { model: spec.directory, signal: this.shutdown.signal })) };
    } finally {
      this.transcribing = false;
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    this.download?.abort.abort();
    await this.deps.engine.close();
  }

  /** Progress arrives per chunk; the window gets one change event per 2 MB. */
  private trackProgress(download: Download, received: number): void {
    const previous = download.receivedBytes;
    download.receivedBytes = received;
    if (Math.floor(received / PROGRESS_STEP_BYTES) !== Math.floor(previous / PROGRESS_STEP_BYTES)) this.deps.ctx.events.changed('speech');
  }

  private recordFailure(download: Download, err: unknown): void {
    if (download.abort.signal.aborted) return;
    this.lastError = {
      model: download.model,
      message: err instanceof AppError ? err.message : 'Der Download des Spracherkennungsmodells ist fehlgeschlagen.',
    };
    this.deps.ctx.logger.warn('speech', 'Model download failed', { error: err });
  }
}
