const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface SettingsChanges {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** The settings that differ, as dotted paths (`privacy.mode`) with their value before and after; empty when nothing changed. */
export function settingsChanges(before: unknown, after: unknown, path = ''): SettingsChanges {
  const changes: SettingsChanges = { before: {}, after: {} };
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const nested = settingsChanges(before[key], after[key], path ? `${path}.${key}` : key);
      Object.assign(changes.before, nested.before);
      Object.assign(changes.after, nested.after);
    }
    return changes;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.before[path] = before ?? null;
    changes.after[path] = after ?? null;
  }
  return changes;
}
