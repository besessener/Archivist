import { describe, expect, it } from 'vitest';
import { describeMicrophoneError, formatDuration, joinDictation, mixToMono, toInt16 } from '../../apps/renderer/lib/dictation';

describe('dictation audio', () => {
  it('keeps a single channel as it is and averages several', () => {
    const left = Float32Array.of(0.5, -0.5, 1);
    expect(mixToMono([left])).toBe(left);
    expect([...mixToMono([Float32Array.of(1, 0, -1), Float32Array.of(0, 0.5, -1)])]).toEqual([0.5, 0.25, -1]);
    expect(mixToMono([])).toHaveLength(0);
  });

  it('converts floats to 16-bit samples and clips what is out of range', () => {
    expect([...toInt16(Float32Array.of(0, 1, -1, 0.5, 2, -3))]).toEqual([0, 32_767, -32_767, 16_384, 32_767, -32_767]);
  });
});

describe('dictation text', () => {
  it('formats the elapsed time', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7.9)).toBe('0:07');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(120)).toBe('2:00');
  });

  it('puts dictated text after what the user already typed', () => {
    expect(joinDictation('', 'Hallo Welt.')).toBe('Hallo Welt.');
    expect(joinDictation('  \n', 'Hallo Welt.')).toBe('Hallo Welt.');
    expect(joinDictation('Notiz:', 'Hallo Welt.')).toBe('Notiz: Hallo Welt.');
    expect(joinDictation('Notiz: \n', 'Hallo Welt.')).toBe('Notiz: Hallo Welt.');
  });
});

describe('microphone errors', () => {
  const failure = (name: string) => describeMicrophoneError(new DOMException('x', name));

  it('says what to do when there is no microphone', () => {
    expect(failure('NotFoundError')).toContain('kein Mikrofon');
  });

  it('points to the Windows privacy setting when access is denied', () => {
    expect(failure('NotAllowedError')).toContain('Datenschutz');
  });

  it('names a microphone that another program holds', () => {
    expect(failure('NotReadableError')).toContain('anderes Programm');
  });

  it('has a plain answer for anything else', () => {
    expect(describeMicrophoneError(new Error('?'))).toBe('Die Aufnahme konnte nicht gestartet werden.');
  });
});
