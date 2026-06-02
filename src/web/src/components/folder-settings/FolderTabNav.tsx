import { Bot, FileText, Info, ShieldCheck, Tags, Workflow } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Tab nav for FolderSettingsDialog — grouped vertical buttons,
 * mirrors the workspace-level SettingsDialog nav (w-56). Gated tabs
 * grey out (but stay clickable) when the folder is hidden from AI.
 */

export type FolderSettingsTab =
  | 'general'
  | 'access'
  | 'summary'
  | 'topics'
  | 'auto-code'
  | 'workflows';

export interface FolderTabSpec {
  key: FolderSettingsTab;
  label: string;
  icon: React.ReactNode;
  /** Optional category divider before this tab. */
  group?: 'Folder' | 'Folder Memory' | 'Automation';
  /** Tab is greyed out when the folder is hidden from AI (Mo can't
   *  read it, so Mo-dependent tabs are inactive). */
  gatedByAccess?: boolean;
}

export const FOLDER_TAB_SPECS: FolderTabSpec[] = [
  { key: 'general', label: 'General', icon: <Info className="h-3.5 w-3.5" />, group: 'Folder' },
  { key: 'access', label: 'Access Permissions', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  {
    key: 'summary',
    label: 'Indexed Summary',
    icon: <FileText className="h-3.5 w-3.5" />,
    group: 'Folder Memory',
    gatedByAccess: true,
  },
  {
    key: 'topics',
    label: 'Indexed Topics',
    icon: <Tags className="h-3.5 w-3.5" />,
    gatedByAccess: true,
  },
  {
    key: 'auto-code',
    label: 'Auto-code',
    icon: <Bot className="h-3.5 w-3.5" />,
    group: 'Automation',
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: <Workflow className="h-3.5 w-3.5" />,
  },
];

export function FolderTabButton({
  spec,
  active,
  blocked,
  onClick,
}: {
  spec: FolderTabSpec;
  active: boolean;
  blocked: boolean;
  onClick: () => void;
}) {
  return (
    <>
      {spec.group && (
        <li role="presentation" className="mt-3 first:mt-0">
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {spec.group}
          </div>
        </li>
      )}
      <li role="presentation">
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={onClick}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
            active
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            blocked && 'opacity-60',
          )}
        >
          <span className="shrink-0 opacity-70">{spec.icon}</span>
          <span className="flex-1 truncate">{spec.label}</span>
        </button>
      </li>
    </>
  );
}
