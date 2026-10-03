import { describe, expect, it } from 'vitest';
import {
  BAND_COUNT,
  NEAR_DUPLICATE_THRESHOLD,
  areNearDuplicates,
  bandBuckets,
  estimatedJaccard,
  minhashSignature,
  signatureFromBytes,
  signatureToBytes,
} from '../../packages/core/src/util/minhash';

const WORDS = ['rechnung', 'wartung', 'heizung', 'vertrag', 'kunde', 'lieferung', 'angebot', 'frist', 'zahlung', 'projekt', 'termin', 'bericht'];
/** Deterministic running text of `count` words where no three consecutive words repeat. */
const textOf = (count: number, seed = 0): string =>
  Array.from({ length: count }, (_, index) => `${WORDS[(index * 7 + seed) % WORDS.length]}${(index * 31 + seed) % 97}`).join(' ');

const signature = (text: string) => minhashSignature(text)!;

describe('MinHash signatures', () => {
  it('gives identical texts identical signatures, regardless of case and punctuation', () => {
    const text = textOf(300);
    expect(estimatedJaccard(signature(text), signature(text.toUpperCase().replaceAll(' ', ',  ')))).toBe(1);
  });

  it('treats a text with a few edited words as near-duplicate', () => {
    const words = textOf(400).split(' ');
    for (const index of [10, 150, 300]) words[index] = 'geaendert';
    expect(areNearDuplicates(signature(textOf(400)), signature(words.join(' ')))).toBe(true);
  });

  it('keeps a text apart from one with a fifth of its words replaced', () => {
    const words = textOf(400).split(' ');
    for (let index = 0; index < 400; index += 5) words[index] = `neu${index}`;
    expect(estimatedJaccard(signature(textOf(400)), signature(words.join(' ')))).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it('keeps different texts apart', () => {
    expect(estimatedJaccard(signature(textOf(300)), signature(textOf(300, 5).replaceAll(/\d+/g, (n) => `${Number(n) + 500}`)))).toBeLessThan(0.3);
  });

  it('gives no signature to texts of 200 characters or fewer', () => {
    expect(minhashSignature('a'.repeat(200))).toBeNull();
    expect(minhashSignature('wort '.repeat(41))).not.toBeNull();
  });

  it('gives no signature to a text without words', () => {
    expect(minhashSignature('.'.repeat(300))).toBeNull();
  });

  it('shares band buckets between near-duplicates and not between different texts', () => {
    const base = bandBuckets(signature(textOf(400)));
    const words = textOf(400).split(' ');
    words[200] = 'geaendert';
    const shared = (other: number[]) => other.filter((bucket, band) => bucket === base[band]).length;
    expect(base).toHaveLength(BAND_COUNT);
    expect(shared(bandBuckets(signature(words.join(' '))))).toBeGreaterThan(BAND_COUNT / 2);
    expect(shared(bandBuckets(signature(textOf(400, 3).replaceAll(/\d+/g, (n) => `${Number(n) + 700}`))))).toBe(0);
  });

  it('survives storing as bytes and rejects bytes of another size', () => {
    const original = signature(textOf(300));
    expect(signatureFromBytes(signatureToBytes(original))).toEqual(original);
    expect(signatureFromBytes(new Uint8Array(10))).toBeNull();
  });
});
