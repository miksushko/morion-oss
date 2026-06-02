import {
  Info,
  BarChart3,
  Bot,
  Server,
  Sparkles,
  ScrollText,
  SlidersHorizontal,
} from 'lucide-react';
import type { McpSettings } from '../../lib/api';
import type { UpdateCheckResult } from '../UpdateBanner';

export type SettingsTab =
  | 'general'
  | 'limits'
  | 'usage'
  | 'mo-agent'
  | 'mcp-server'
  | 'skills'
  | 'logs';

export interface SettingsDialogProps {
  initialTab?: SettingsTab;
  onClose: () => void;
  /** Manual update check — same handler the gear menu uses today. May
   *  return the structured result so the dialog renders an inline badge. */
  onCheckForUpdates?: () => Promise<UpdateCheckResult | null | void>;
  /** Bulk refresh of notes / folders / tags / trash. */
  onRefreshData?: () => Promise<void>;
  /** MCP Server tab toggles the master MCP enable. */
  onMcpStateChange?: (mcp: McpSettings) => void;
}

export interface TabSpec {
  key: SettingsTab;
  label: string;
  icon: React.ReactNode;
  /** Optional category divider before this tab. Renders a label above
   *  the tab in the nav rail. */
  group?: 'Account' | 'Workspace';
}

export const TAB_SPECS: TabSpec[] = [
  { key: 'general', label: 'General', icon: <Info className="h-3.5 w-3.5" />, group: 'Account' },
  { key: 'limits', label: 'Limits', icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
  { key: 'usage', label: 'Usage', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { key: 'mo-agent', label: 'Mo Agent', icon: <Bot className="h-3.5 w-3.5" />, group: 'Workspace' },
  { key: 'mcp-server', label: 'MCP Server', icon: <Server className="h-3.5 w-3.5" /> },
  { key: 'skills', label: 'Skills', icon: <Sparkles className="h-3.5 w-3.5" /> },
  { key: 'logs', label: 'Logs', icon: <ScrollText className="h-3.5 w-3.5" /> },
];

export type UpdateBadge =
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'unavailable' }
  | { kind: 'done' };
