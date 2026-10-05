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

/** `model-pin.json` is written by `npm run speech:pin` (commit, files and checksums), never by hand. */
export const SPEECH_MODEL: SpeechModelSpec = {
  label: 'Whisper small (quantisiert)',
  directory: 'whisper-small',
  baseUrl: 'https://huggingface.co/onnx-community/whisper-small/resolve',
  revision: pin.revision,
  files: pin.files,
};

export const totalBytes = (spec: SpeechModelSpec): number => spec.files.reduce((sum, file) => sum + file.bytes, 0);

export const fileUrl = (spec: SpeechModelSpec, file: SpeechModelFile): string => `${spec.baseUrl}/${spec.revision}/${file.path}`;
