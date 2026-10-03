import type { Category } from '@archivist/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context';
import { categories } from '../db/schema';
import { AppError } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { sanitizeCategoryPath } from '../util/paths';

const SEED_CATEGORIES = ['work', 'private'];

/** Categories (relative folder paths in the archive); new main categories (first segment) need explicit confirmation. */
export class CategoryService {
  constructor(private readonly ctx: AppContext) {
    for (const seed of SEED_CATEGORIES) this.insertIfMissing(seed);
  }

  private get db() {
    return this.ctx.database.db;
  }

  private insertIfMissing(p: string): void {
    if (!this.db.select().from(categories).where(eq(categories.path, p)).get()) {
      this.db.insert(categories).values({ id: newId(), path: p, approved: true, createdAt: nowIso() }).run();
    }
  }

  list(): Category[] {
    return this.db
      .select()
      .from(categories)
      .orderBy(categories.path)
      .all()
      .map((c) => ({ id: c.id, path: c.path, approved: c.approved, createdAt: c.createdAt }));
  }

  mainCategories(): string[] {
    return this.list()
      .filter((c) => !c.path.includes('/') && c.approved)
      .map((c) => c.path);
  }

  /** Returns the main category if it has not been confirmed yet, otherwise null. */
  needsApproval(categoryPath: string): string | null {
    const main = categoryPath.split('/')[0]!;
    return this.mainCategories().some((m) => m.toLowerCase() === main.toLowerCase()) ? null : main;
  }

  /** Existing category with the same path apart from upper/lower case (NTFS treats both as one folder, #244). */
  canonical(rawPath: string): string {
    const p = sanitizeCategoryPath(rawPath);
    const all = this.list();
    const exact = all.find((c) => c.path === p);
    if (exact) return exact.path;
    // keep the casing of every known leading segment
    const parts = p.split('/');
    for (let i = parts.length; i > 0; i -= 1) {
      const prefix = parts.slice(0, i).join('/').toLowerCase();
      const known = all.find((c) => c.path.toLowerCase() === prefix);
      if (known) return [known.path, ...parts.slice(i)].join('/');
    }
    return p;
  }

  /** Removes a category entry (only used for empty folders). */
  remove(p: string): void {
    this.db.delete(categories).where(eq(categories.path, p)).run();
    this.ctx.events.changed('documents');
  }

  /** Creates the path including intermediate levels. New main categories only with `confirmed`. */
  create(rawPath: string, { confirmed }: { confirmed: boolean }): Category {
    const p = sanitizeCategoryPath(rawPath);
    const main = this.needsApproval(p);
    if (main && !confirmed) throw new AppError('permission_error', `Die neue Hauptkategorie „${main}“ muss ausdrücklich bestätigt werden.`);
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i += 1) this.insertIfMissing(parts.slice(0, i).join('/'));
    this.ctx.events.changed('documents');
    const row = this.db.select().from(categories).where(eq(categories.path, p)).get()!;
    return { id: row.id, path: row.path, approved: row.approved, createdAt: row.createdAt };
  }
}
