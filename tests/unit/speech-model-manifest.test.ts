import { describe, expect, it } from 'vitest';
import { SPEECH_MODEL_NAMES } from '@archivist/shared';
import models from '../../packages/core/src/services/speech/models.json';
import pin from '../../packages/core/src/services/speech/model-pin.json';
import { SPEECH_MODELS, fileUrl, totalBytes } from '../../packages/core/src/services/speech/model-manifest';

describe('speech model manifest', () => {
  it('offers exactly the models of the settings, each with a description and a pin', () => {
    expect(Object.keys(models)).toEqual([...SPEECH_MODEL_NAMES]);
    expect(Object.keys(pin)).toEqual([...SPEECH_MODEL_NAMES]);
    expect(Object.keys(SPEECH_MODELS)).toEqual([...SPEECH_MODEL_NAMES]);
  });

  it('describes every model from the list and its pin', () => {
    for (const name of SPEECH_MODEL_NAMES) {
      expect(SPEECH_MODELS[name]).toMatchObject({
        label: models[name].label,
        directory: models[name].directory,
        baseUrl: `https://huggingface.co/${models[name].repository}/resolve`,
        revision: pin[name].revision,
        files: pin[name].files,
      });
    }
  });

  it('gives every model its own folder', () => {
    const directories = Object.values(models).map((model) => model.directory);
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('builds the download address from the pinned commit and sums the sizes', () => {
    const spec = {
      ...SPEECH_MODELS.small,
      baseUrl: 'https://host/repo/resolve',
      revision: 'abc',
      files: [
        { path: 'onnx/a.onnx', bytes: 3, sha256: 'x' },
        { path: 'b.json', bytes: 4, sha256: 'y' },
      ],
    };
    expect(fileUrl(spec, spec.files[0]!)).toBe('https://host/repo/resolve/abc/onnx/a.onnx');
    expect(totalBytes(spec)).toBe(7);
  });
});
