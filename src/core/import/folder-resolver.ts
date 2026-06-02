import type { FoldersRepository } from '../folders/repository.js';

/**
 * Resolves source filesystem paths to Morion folder ids, creating
 * folders on demand. Used by the import engine to mirror a vault's
 * directory hierarchy as nested Morion folders.
 *
 * Two collision rules apply at different levels:
 *
 *  1. **Top-level (root) collision** — when a folder import lands a
 *     folder named `MyVault` and the user already has a `MyVault`
 *     folder in Morion's root, we DON'T merge. Instead the new
 *     top-level folder gets `(2)` / `(3)` suffix. Reason: imports are
 *     one-shot operations; merging into an existing user folder would
 *     make it impossible to "undo" the import later (delete the new
 *     `MyVault (2)` folder). Append-with-suffix preserves the user's
 *     existing data and gives them a clean revert path.
 *
 *  2. **Within-import subfolder collision** — when the source vault has
 *     `Projects/foo.md` and `Projects/bar.md`, both files should land
 *     in the SAME Morion subfolder `Projects` under the import root.
 *     We merge here (otherwise we'd plouw `Projects` and `Projects (2)`
 *     for two files from the same source folder, which is absurd).
 *
 * The resolver caches by relPath → Morion folder id within a single
 * batch so the second file in `Projects/` reuses the same id created
 * for the first. The cache is per-instance; a new `FolderResolver` =
 * a fresh batch.
 */

export class FolderResolver {
  /** relPath → Morion folder id. Empty-string key = the import root. */
  private readonly cache = new Map<string, string>();

  constructor(private readonly folders: FoldersRepository) {}

  /**
   * Create the top-level (root) Morion folder for a folder-mode import.
   * The source folder name is used verbatim with `(N)` suffix on
   * collision. Returns the folder id.
   *
   * Pass `null` for single-file imports — returns null and the file
   * lands in the unfiled root.
   */
  createImportRoot(sourceFolderName: string | null): string | null {
    if (sourceFolderName === null) return null;
    const id = this.findFreeRootName(sourceFolderName);
    this.cache.set('', id);
    return id;
  }

  /**
   * Resolve a relative path under the import root to a Morion folder
   * id, creating intermediate Morion folders as needed.
   *
   * `relPath` is the source file's parent-directory path under the
   * root. Empty string = directly under the root folder.
   *
   * For a single-file import (`createImportRoot(null)`), passing
   * empty-string returns null (the unfiled root).
   */
  resolveForRelPath(relPath: string): string | null {
    const cached = this.cache.get(relPath);
    if (cached !== undefined) return cached;

    if (relPath === '') {
      // No root, no nesting — single-file mode.
      return null;
    }

    // Walk path segments, creating + caching at each level.
    const segments = relPath.split('/').filter((s) => s.length > 0);
    let parentId: string | null = this.cache.get('') ?? null;
    let walked = '';
    for (const segment of segments) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      const fromCache = this.cache.get(walked);
      if (fromCache !== undefined) {
        parentId = fromCache;
        continue;
      }
      const created = this.folders.getOrCreate(segment, parentId);
      this.cache.set(walked, created.id);
      parentId = created.id;
    }
    return parentId;
  }

  /**
   * Pick the first free name in the form `name`, `name (2)`, `name (3)`
   * for a top-level Morion folder, then create it. Used only at the
   * root level — subfolders within an import always merge by name.
   */
  private findFreeRootName(baseName: string): string {
    let attempt = baseName;
    let n = 2;
    while (this.folders.getByName(attempt, null) !== null) {
      attempt = `${baseName} (${n})`;
      n++;
    }
    return this.folders.create(attempt, null).id;
  }
}
