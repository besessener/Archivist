/** JSON-serializable value (for JSON columns). */
export type ArchivistJson = string | number | boolean | null | ArchivistJson[] | { [key: string]: ArchivistJson };
