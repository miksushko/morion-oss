import type { ToolCategory } from '../../lib/api';

export const CATEGORY_ORDER: ToolCategory[] = ['read', 'create', 'update', 'delete'];
export const CATEGORY_LABELS: Record<ToolCategory, { title: string; blurb: string }> = {
  read: {
    title: 'Read',
    blurb: 'Search, list, fetch notes, browse folders/tags, view audit history.',
  },
  create: {
    title: 'Create',
    blurb: 'Make new notes / folders / tags, append text, duplicate items.',
  },
  update: {
    title: 'Update',
    blurb: 'Rename, move, reorder, recolor — changes existing rows in place.',
  },
  delete: {
    title: 'Delete',
    blurb: 'Soft-delete notes, drop folders, remove tags. Notes survive folder/tag deletion.',
  },
};
