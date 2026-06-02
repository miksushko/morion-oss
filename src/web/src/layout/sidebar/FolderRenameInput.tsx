import { useEffect, useRef, useState } from 'react';

/** Inline rename input — appears in place of a folder row while the
 *  user is editing. Submits on Enter / blur, cancels on Escape. */
export function FolderRenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSubmit(value.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSubmit(value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="flex-1 rounded-sm border border-border bg-background px-1 py-0.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
