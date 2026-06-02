import { TagManager } from '../layout/TagManager';
import { cn } from '../lib/cn';
import type { Tag } from '../lib/api';
import type { MobilePane } from '../appShellTypes';

/**
 * Tags view branch — just `<TagManager />` inside the editor pane
 * slot. On mobile the folder pane collapses (mobilePane === 'editor').
 */
export interface TagsViewProps {
  tags: Tag[];
  paneClass: (pane: MobilePane) => string;
  setMobilePane: (pane: MobilePane) => void;
  onCreate: (name: string, color: string | null) => Promise<Tag>;
  onUpdate: (id: string, patch: { name?: string; color?: string | null }) => Promise<Tag>;
  onDelete: (id: string) => Promise<void>;
}

export function TagsView({ tags, paneClass, setMobilePane, onCreate, onUpdate, onDelete }: TagsViewProps) {
  return (
    <div className={cn('min-w-0 flex-1', paneClass('editor'))}>
      <TagManager
        tags={tags}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMobileBack={() => setMobilePane('folders')}
      />
    </div>
  );
}
