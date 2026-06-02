import { useState } from 'react';
import { Copy as CopyIcon, Terminal } from 'lucide-react';
import type { AutoCodeQueueRow } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { DrawerSessionEntry } from './types';
import { resumeCwdForRow } from './helpers';

export function DrawerFooter({
  row,
  session,
}: {
  row: AutoCodeQueueRow;
  session: DrawerSessionEntry;
}) {
  const sessionId = session.sessionId;
  const cwd = resumeCwdForRow(row);
  const cmd = sessionId ? `cd "${cwd}" && claude -p --resume ${sessionId}` : '';
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard write can throw in some sandboxed iframes — silent
      // fail; user can still read the cmd from the textarea.
    }
  };

  return (
    <div className="border-t bg-muted/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Terminal className="h-3.5 w-3.5" />
        Resume this session in your terminal
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-xs">
          {cmd || '(no session id yet)'}
        </code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!cmd}
          className={cn(
            'flex items-center gap-1 rounded border px-2 py-1 text-xs',
            cmd ? 'hover:bg-muted' : 'cursor-not-allowed opacity-40',
          )}
        >
          <CopyIcon className="h-3 w-3" />
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}
