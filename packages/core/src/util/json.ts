/** JSON-serialisierbarer Wert (für JSON-Spalten). */
export type ArchivistJson = string | number | boolean | null | ArchivistJson[] | { [key: string]: ArchivistJson };
