import type { SettingsRepository } from '../settings/repository.js';

/**
 * Workspace-level Mo memory.
 *
 * One markdown blob per notebook, stored as a settings KV. Mo reads
 * it on every smart-tool call (`mo_ask`, `mo_record`) so durable
 * preferences / decisions / facts the user-or-Mo wants to remember
 * survive across folders and sessions. Like Claude / ChatGPT memory
 * but workspace-scoped.
 *
 * Why settings KV and not a dedicated note + revisions:
 *   - Simpler — no migration, no sentinel-id-in-settings indirection.
 *   - Memory edits are rare (a few per day, mostly Mo-initiated) so
 *     the missing revision history isn't load-bearing in v1.
 *   - If dogfood shows users want undo-on-edit, migrate to a real
 *     note (revisions for free) or a `mo_memory` table with
 *     row-per-fact.
 *
 * Body shape: free-form markdown. Mo writes structured sections
 * (`## Preferences`, `## Decisions`, `## Project conventions`) when
 * it has multiple items; agents and the user can rewrite freely.
 * The repo doesn't enforce any structure — Mo's prompt does.
 *
 * No size cap enforced here. Settings KV can hold arbitrary JSON;
 * a runaway memory would surface as ballooning Mo prompt token
 * counts (and the existing monthly $10 cap), not as a DB issue.
 */

const MEMORY_KEY = 'mo.memory';

export class MoMemoryRepository {
  constructor(private readonly settings: SettingsRepository) {}

  /** Current memory body, or empty string when unset. Stable contract:
   * callers can always concat / display without null-checking. */
  read(): string {
    return this.settings.get<string>(MEMORY_KEY, '');
  }

  /** Replace the entire body. Used by `mo_remember` (after Mo decides
   * the merge) and by the user via the Settings UI. */
  write(body: string): void {
    this.settings.set(MEMORY_KEY, body);
  }

  /** Convenience: append a `## <heading>\n<text>` section to the
   * current body. When the body is empty, becomes the first section.
   * Used as a fallback when `mo_remember`'s LLM returns the appended
   * shape rather than a full rewritten body. */
  appendSection(heading: string, text: string): string {
    const cur = this.read().trim();
    const block = `## ${heading.trim()}\n${text.trim()}`;
    const next = cur ? `${cur}\n\n${block}` : block;
    this.write(next);
    return next;
  }
}
