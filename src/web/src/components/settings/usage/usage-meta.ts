import type { UsageKind, UsagePeriod } from '../../../lib/api';

/**
 * Maps the `MoSpendKind` discriminator to a human label + a tri-split
 * bucket (Interactive / Background / Auto-code). Centralised here so
 * adding a new `MoSpendKind` on the server side is one row in this
 * table + one entry in the `UsageKind` union — every Usage tab section
 * reads from this map.
 */
export const KIND_META: Record<
  UsageKind,
  { label: string; bucket: 'interactive' | 'background' | 'auto-code' }
> = {
  chat: { label: 'Mo Chat', bucket: 'interactive' },
  mo_tool: { label: 'Mo Smart Tools (record / remember / forget)', bucket: 'interactive' },
  mo_gather: { label: 'Mo Deep Research (get_context / ask)', bucket: 'interactive' },
  mo_indexing_tier1: { label: 'Indexing — per-note metadata (Tier 1)', bucket: 'background' },
  mo_indexing_tier2: { label: 'Indexing — topic regen (Tier 2)', bucket: 'background' },
  mo_indexing_catalog: { label: 'Indexing — catalog (Tier 2.5)', bucket: 'background' },
  mo_topic_hygiene: { label: 'Topic cleanup', bucket: 'background' },
  tick: { label: 'Mo Background Patrol (legacy)', bucket: 'background' },
  brief: { label: 'Project Memory (legacy)', bucket: 'background' },
  'auto-code-fix': { label: 'Auto-code — Fix stage', bucket: 'auto-code' },
  'auto-code-review': { label: 'Auto-code — Review stage', bucket: 'auto-code' },
  'auto-code-merge-resolve': { label: 'Auto-code — Merge resolver', bucket: 'auto-code' },
};

export const BUCKET_META: Record<
  'interactive' | 'background' | 'auto-code',
  { label: string; tone: string; description: string }
> = {
  interactive: {
    label: 'Interactive',
    tone: 'bg-sky-500',
    description: 'Your own chats and explicit tool calls',
  },
  background: {
    tone: 'bg-violet-500',
    label: 'Background',
    description: 'Mo indexing, catalog regen, topic cleanup',
  },
  'auto-code': {
    label: 'Auto-code',
    tone: 'bg-amber-500',
    description: 'Kanban → Claude → review → Mo workflow',
  },
};

export const USAGE_PERIODS: ReadonlyArray<{ key: UsagePeriod; label: string }> = [
  { key: 'current_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_7d', label: '7 days' },
  { key: 'last_30d', label: '30 days' },
  { key: 'all_time', label: 'All time' },
];

export const PROVIDER_DASHBOARDS: ReadonlyArray<{
  provider: string;
  label: string;
  url: string;
}> = [
  { provider: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/activity' },
  { provider: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/usage' },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    url: 'https://console.anthropic.com/settings/usage',
  },
  { provider: 'groq', label: 'Groq', url: 'https://console.groq.com/usage' },
];
