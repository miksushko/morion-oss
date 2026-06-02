import { useEffect, useState } from 'react';
import type { CanvasMcpToolStage } from '../types';

export function McpToolBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasMcpToolStage;
  onPatch: (p: Partial<CanvasMcpToolStage>) => void;
  disabled?: boolean;
}) {
  const [argsText, setArgsText] = useState(
    JSON.stringify(stage.argsTemplate ?? {}, null, 2),
  );
  const [argsError, setArgsError] = useState<string | null>(null);
  useEffect(() => {
    setArgsText(JSON.stringify(stage.argsTemplate ?? {}, null, 2));
    setArgsError(null);
  }, [stage.argsTemplate]);
  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Tool name
        <input
          value={stage.toolName}
          onChange={(e) => onPatch({ toolName: e.target.value })}
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Max attempts
        <input
          type="number"
          min={1}
          value={stage.maxAttempts ?? 1}
          onChange={(e) =>
            onPatch({ maxAttempts: Math.max(1, Number(e.target.value)) })
          }
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        argsTemplate (JSON object)
        <textarea
          value={argsText}
          onChange={(e) => {
            const next = e.target.value;
            setArgsText(next);
            try {
              const parsed = JSON.parse(next);
              if (
                parsed === null ||
                typeof parsed !== 'object' ||
                Array.isArray(parsed)
              ) {
                setArgsError('argsTemplate must be a JSON object');
                return;
              }
              setArgsError(null);
              onPatch({ argsTemplate: parsed as Record<string, unknown> });
            } catch (e2) {
              setArgsError((e2 as Error).message);
            }
          }}
          disabled={disabled}
          rows={6}
          spellCheck={false}
          className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
        />
        {argsError && (
          <span className="text-[10px] text-destructive">{argsError}</span>
        )}
      </label>
    </div>
  );
}
