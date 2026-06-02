import { cn } from '../../lib/cn';
import type { TabSpec } from './types';

export function SettingsTabButton({
  spec,
  active,
  onClick,
}: {
  spec: TabSpec;
  active: boolean;
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
          )}
        >
          <span className="shrink-0 opacity-70">{spec.icon}</span>
          <span className="flex-1 truncate">{spec.label}</span>
        </button>
      </li>
    </>
  );
}
