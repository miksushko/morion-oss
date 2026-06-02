import { SectionDivider } from './leaf';
import { MoGeneralSection } from './mo-agent/MoGeneralSection';
import { MoApiProviderSection } from './mo-agent/MoApiProviderSection';
import { MoDataIndexingSection } from './mo-agent/MoDataIndexingSection';
import { MoPersonalitySection } from './mo-agent/MoPersonalitySection';
import { MoMemorySection } from './mo-agent/MoMemorySection';

/**
 * Mo Agent — single tab containing five vertically-stacked sections,
 * mirroring the user's spec ordering in epic 01KPGWTJCWVBQCCSQ8NGSB19KQ:
 *
 *   1. General        — informational; how Mo gets enabled
 *   2. API & Provider — backend / API key / chat-tier model + per-pipeline overrides
 *   3. Mo Data Indexing — master kill-switch + explanation
 *   4. Mo Personality — Grumpy mode toggle
 *   5. Mo Memory      — workspace-wide memory body editor
 *
 * Each section fetches its own state via `api.*` — self-contained.
 * Lifting state to App.tsx is deferred until the legacy
 * MoSettingsDialog gets deleted.
 */
export function MoAgentTab() {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Mo Agent</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Mo's brain — the workspace agent that searches, summarises, and
          (when wired) drives the auto-code workflows. Five sections
          covering provider, indexing, personality, and memory.
        </p>
      </header>

      <MoGeneralSection />
      <SectionDivider />
      <MoApiProviderSection />
      <SectionDivider />
      <MoDataIndexingSection />
      <SectionDivider />
      <MoPersonalitySection />
      <SectionDivider />
      <MoMemorySection />
    </div>
  );
}
