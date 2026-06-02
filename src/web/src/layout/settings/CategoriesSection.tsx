import type { McpSettings, SettingsResponse } from '../../lib/api';
import { cn } from '../../lib/cn';
import { CATEGORY_LABELS, CATEGORY_ORDER } from './categoryLabels';
import { SectionHeader } from './SectionHeader';
import { Toggle } from './Toggle';

// ---------- 2. category toggles ----------

export function CategoriesSection({
  mcp,
  tools,
  onPatch,
}: {
  mcp: McpSettings;
  tools: SettingsResponse['toolsByCategory'];
  onPatch: (next: { categories?: Partial<McpSettings['categories']> }) => Promise<void>;
}) {
  return (
    <section>
      <SectionHeader
        title="Tool categories"
        blurb="Fine-grained gates within the master switch. Disable a category and the matching tools return an mcp_category_disabled envelope."
      />
      <div className="flex flex-col gap-3">
        {CATEGORY_ORDER.map((cat) => {
          const enabled = mcp.categories[cat];
          const list = tools[cat] ?? [];
          const meta = CATEGORY_LABELS[cat];
          return (
            <div
              key={cat}
              className={cn(
                'rounded-lg border border-border bg-card px-4 py-3 transition-opacity',
                !mcp.enabled && 'opacity-50',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {meta.title}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({list.length})
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{meta.blurb}</div>
                </div>
                <Toggle
                  checked={enabled}
                  disabled={!mcp.enabled}
                  onChange={(v) => onPatch({ categories: { [cat]: v } })}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {list.map((t) => (
                  <span
                    key={t.name}
                    title={t.description}
                    className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
