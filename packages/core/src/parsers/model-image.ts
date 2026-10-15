/** An image as it goes to a vision model: base64 without a data-URL prefix. */
export interface ModelImage {
  mediaType: 'image/jpeg';
  data: string;
}

/** Longest edge the providers still read at full detail; larger images only cost more tokens. */
export const MODEL_IMAGE_EDGE = 1568;

/** Rotated per EXIF, shrunk to `MODEL_IMAGE_EDGE`, transparency on white, re-encoded as JPEG – EXIF metadata (location) is dropped. */
export async function prepareModelImage(file: string): Promise<ModelImage> {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp(file, { failOn: 'none', limitInputPixels: 268_000_000 })
    .rotate()
    .resize({ width: MODEL_IMAGE_EDGE, height: MODEL_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: 'image/jpeg', data: buffer.toString('base64') };
}
