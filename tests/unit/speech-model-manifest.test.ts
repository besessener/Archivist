import { describe, expect, it } from 'vitest';
import models from '../../packages/core/src/services/speech/models.json';
import pin from '../../packages/core/src/services/speech/model-pin.json';
import { SPEECH_MODEL, fileUrl, totalBytes } from '../../packages/core/src/services/speech/model-manifest';

describe('speech model manifest', () => {
  it('pins one of the offered models and describes it from the list', () => {
    expect(Object.keys(models)).toEqual(['small', 'medium', 'turbo']);
    expect(Object.keys(models)).toContain(pin.model);
    const chosen = models[pin.model as keyof typeof models];
    expect(SPEECH_MODEL).toMatchObject({ label: chosen.label, directory: chosen.directory, baseUrl: `https://huggingface.co/${chosen.repository}/resolve` });
  });

  it('offers every model its own folder', () => {
    const directories = Object.values(models).map((model) => model.directory);
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('builds the download address from the pinned commit and sums the sizes', () => {
    const spec = {
      ...SPEECH_MODEL,
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
