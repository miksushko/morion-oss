import { Bot, CheckCircle2, User, Wrench, XCircle } from 'lucide-react';
import type { AutoCodeTranscriptMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { truncate } from './helpers';

export function MessageBubble({ message: m }: { message: AutoCodeTranscriptMessage }) {
  if (m.kind === 'tool_use') {
    return (
      <div className="flex items-start gap-2 rounded border border-blue-500/30 bg-blue-500/5 p-2 text-xs">
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <code className="break-words font-mono text-blue-700 dark:text-blue-400">{m.text}</code>
      </div>
    );
  }
  if (m.kind === 'tool_result') {
    const isError = m.toolResult?.isError === true;
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded border p-2 text-xs',
          isError
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-emerald-500/30 bg-emerald-500/5',
        )}
      >
        {isError ? (
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        )}
        <pre
          className={cn(
            'overflow-hidden whitespace-pre-wrap break-words font-mono',
            isError ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400',
          )}
        >
          {truncate(m.text, 800)}
        </pre>
      </div>
    );
  }
  const isAssistant = m.kind === 'assistant';
  return (
    <div className={cn('flex items-start gap-2 text-sm', isAssistant ? 'flex-row' : 'flex-row')}>
      {isAssistant ? (
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      ) : (
        <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div
        className={cn(
          'rounded-lg px-3 py-2',
          isAssistant ? 'bg-muted' : 'bg-secondary text-secondary-foreground',
        )}
      >
        <pre className="whitespace-pre-wrap break-words font-sans text-sm">
          {truncate(m.text, 4_000)}
        </pre>
      </div>
    </div>
  );
}
