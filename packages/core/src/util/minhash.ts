import { normalizeName } from './text';

/** Jaccard similarity of the word shingles from which two texts count as near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
/** Texts of at most this many characters are too short to compare. */
export const MIN_TEXT_CHARS = 200;

const SIGNATURE_SIZE = 64;
const BAND_ROWS = 4;
const SHINGLE_WORDS = 3;
const MAX_WORDS = 60_000;

export const BAND_COUNT = SIGNATURE_SIZE / BAND_ROWS;
export const SIGNATURE_BYTES = SIGNATURE_SIZE * 4;

export type Signature = Uint32Array;

function mix(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

const SEEDS = Array.from({ length: SIGNATURE_SIZE }, (_, index) => mix(Math.imul(index + 1, 0x9e3779b9)));

function hashShingle(shingle: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < shingle.length; index += 1) hash = Math.imul(hash ^ shingle.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

function shingleHashes(text: string): number[] {
  const words = normalizeName(text).split(' ').filter(Boolean).slice(0, MAX_WORDS);
  if (words.length === 0) return [];
  if (words.length <= SHINGLE_WORDS) return [hashShingle(words.join(' '))];
  const hashes = new Set<number>();
  for (let start = 0; start + SHINGLE_WORDS <= words.length; start += 1) hashes.add(hashShingle(words.slice(start, start + SHINGLE_WORDS).join(' ')));
  return [...hashes];
}

/** MinHash signature over the word shingles of a text; null if the text is too short or has no words. */
export function minhashSignature(text: string): Signature | null {
  if (text.length <= MIN_TEXT_CHARS) return null;
  const hashes = shingleHashes(text);
  if (hashes.length === 0) return null;
  const signature = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const hash of hashes)
    for (let slot = 0; slot < SIGNATURE_SIZE; slot += 1) {
      const value = mix(hash ^ SEEDS[slot]!);
      if (value < signature[slot]!) signature[slot] = value;
    }
  return signature;
}

/** LSH bucket per band: two signatures that agree on all rows of a band share its bucket. */
export function bandBuckets(signature: Signature): number[] {
  return Array.from({ length: BAND_COUNT }, (_, band) => {
    let bucket = band + 1;
    for (let row = 0; row < BAND_ROWS; row += 1) bucket = mix(bucket ^ signature[band * BAND_ROWS + row]!) + row;
    return bucket >>> 0;
  });
}

/** Share of equal slots – an estimate of the Jaccard similarity of the shingle sets. */
export function estimatedJaccard(a: Signature, b: Signature): number {
  let equal = 0;
  for (let slot = 0; slot < SIGNATURE_SIZE; slot += 1) if (a[slot] === b[slot]) equal += 1;
  return equal / SIGNATURE_SIZE;
}

export const areNearDuplicates = (a: Signature, b: Signature): boolean => estimatedJaccard(a, b) >= NEAR_DUPLICATE_THRESHOLD;

export function signatureToBytes(signature: Signature): Buffer {
  const bytes = Buffer.alloc(SIGNATURE_BYTES);
  signature.forEach((value, slot) => bytes.writeUInt32LE(value, slot * 4));
  return bytes;
}

/** The stored signature, or null for bytes of an unexpected size. */
export function signatureFromBytes(bytes: Uint8Array): Signature | null {
  if (bytes.byteLength !== SIGNATURE_BYTES) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: SIGNATURE_SIZE }, (_, slot) => view.readUInt32LE(slot * 4));
}
