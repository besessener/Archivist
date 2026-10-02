/** Previous values of the columns `set` changes (without `updatedAt`), for the undo of an edit. */
export function previousValues<R extends object>(current: R, set: Partial<R>): Partial<R> {
  return Object.fromEntries(Object.keys(set).flatMap((key) => (key === 'updatedAt' ? [] : [[key, current[key as keyof R]]]))) as Partial<R>;
}
