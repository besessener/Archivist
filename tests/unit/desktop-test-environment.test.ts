import { describe, expect, it } from 'vitest';
import { readUnpackagedEnv } from '../../apps/desktop/src/test-environment';

describe('readUnpackagedEnv', () => {
  const env = { ARCHIVIST_TEST_MODE: '1' };

  it('returns the value in an unpackaged build', () => {
    expect(readUnpackagedEnv({ packaged: false, env }, 'ARCHIVIST_TEST_MODE')).toBe('1');
  });

  it('ignores the variable in a packaged build', () => {
    expect(readUnpackagedEnv({ packaged: true, env }, 'ARCHIVIST_TEST_MODE')).toBeUndefined();
  });

  it('returns undefined for an unset variable', () => {
    expect(readUnpackagedEnv({ packaged: false, env }, 'ARCHIVIST_TEST_PICK_DIR')).toBeUndefined();
  });
});
