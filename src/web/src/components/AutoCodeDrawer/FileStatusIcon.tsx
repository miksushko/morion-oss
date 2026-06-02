import { FileEdit, FileMinus, FilePlus } from 'lucide-react';
import type { AutoCodeChangedFile } from '../../lib/api';

export function FileStatusIcon({ status }: { status: AutoCodeChangedFile['status'] }) {
  if (status === 'A')
    return <FilePlus className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (status === 'D')
    return <FileMinus className="h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400" />;
  if (status === 'R' || status === 'C')
    return <FileEdit className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />;
  return <FileEdit className="h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />;
}
