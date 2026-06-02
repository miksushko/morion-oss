/**
 * Barrel re-exporting the section components consumed by
 * `src/web/src/components/SettingsDialog.tsx`. The original
 * 1030-LOC SettingsPanel.tsx was a section library (the
 * top-level route was deleted in Phase 5 of epic
 * 01KPGWTJCWVBQCCSQ8NGSB19KQ); each section now lives in its
 * own file under ./settings/.
 *
 * Downstream code keeps importing from `'../layout/SettingsPanel'`
 * unchanged. New code SHOULD import directly from the per-section
 * module under `./settings/` so tree-shaking and grep both line
 * up with intent.
 */
export { McpSection } from './settings/McpSection';
export { CategoriesSection } from './settings/CategoriesSection';
export { CommentsSection } from './settings/CommentsSection';
export { ConnectSection } from './settings/ConnectSection';
export { SkillsSection } from './settings/SkillsSection';
export { ClientsSection } from './settings/ClientsSection';
export { WhatMoDidSection } from './settings/WhatMoDidSection';
