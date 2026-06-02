import { request } from './http';
import type { Tag } from './types';

/**
 * Tag CRUD. Tags are workspace-wide labels (chip-style) that notes can
 * attach. The server enforces uniqueness on name.
 */
export const tagsApi = {
  listTags: () => request<Tag[]>('/api/tags'),
  createTag: (name: string, color: string | null = null) =>
    request<Tag>('/api/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateTag: (id: string, patch: { name?: string; color?: string | null }) =>
    request<Tag>(`/api/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTag: (id: string) => request<{ ok: boolean }>(`/api/tags/${id}`, { method: 'DELETE' }),
};
