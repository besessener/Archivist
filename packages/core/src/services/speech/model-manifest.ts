import type { SpeechModelName } from '@archivist/shared';
import models from './models.json';
import pin from './model-pin.json';

export interface SpeechModelFile {
  /** Path below the model folder and below the revision on the host. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface SpeechModelSpec {
  label: string;
  /** Folder name below `index/models/`; transformers.js loads the model by this name. */
  directory: string;
  /** Host and repository; a download is `${baseUrl}/${revision}/${file.path}`. */
  baseUrl: string;
  /** A commit, so the files never change under the pinned checksums. */
  revision: string;
  files: SpeechModelFile[];
}

function specOf(name: SpeechModelName): SpeechModelSpec {
  const { label, directory, repository } = models[name];
  return { label, directory, baseUrl: `https://huggingface.co/${repository}/resolve`, revision: pin[name].revision, files: pin[name].files };
}

/** `model-pin.json` (commit, files and checksums per model) is written by `npm run speech:pin`, never by hand. */
export const SPEECH_MODELS: Record<SpeechModelName, SpeechModelSpec> = { small: specOf('small'), medium: specOf('medium'), turbo: specOf('turbo') };

export const totalBytes = (spec: SpeechModelSpec): number => spec.files.reduce((sum, file) => sum + file.bytes, 0);

export const fileUrl = (spec: SpeechModelSpec, file: SpeechModelFile): string => `${spec.baseUrl}/${spec.revision}/${file.path}`;
