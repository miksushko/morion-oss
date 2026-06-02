import { SkillsSection } from '../../layout/SettingsPanel';

export function SkillsTab() {
  // SkillsSection is fully self-contained — fetches via skillsApi,
  // handles install / uninstall / state. Just drop it in with a header.
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Skills</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Morion agent-skill — the canonical SKILL.md that teaches Claude
          / Codex / Cursor / etc. how to use Morion's MCP surface correctly.
        </p>
      </header>
      <SkillsSection />
    </div>
  );
}
