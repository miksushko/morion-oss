import type { ZodRawShape } from 'zod';
import type { ToolDef } from './types.js';
import { notesCreateTool } from './notes_create.js';
import { notesGetTool } from './notes_get.js';
import { notesUpdateTool } from './notes_update.js';
import { notesDeleteTool } from './notes_delete.js';
import { notesListTool } from './notes_list.js';
import { notesSearchTool } from './notes_search.js';
import { notesAppendTool } from './notes_append.js';
import { notesDuplicateTool } from './notes_duplicate.js';
import { notesMoveTool } from './notes_move.js';
import { notesRecentTool } from './notes_recent.js';
import { foldersListTool } from './folders_list.js';
import { foldersCreateTool } from './folders_create.js';
import { foldersRenameTool } from './folders_rename.js';
import { foldersDeleteTool } from './folders_delete.js';
import { foldersReorderTool } from './folders_reorder.js';
import { foldersDuplicateTool } from './folders_duplicate.js';
import { foldersMoveTool } from './folders_move.js';
import { foldersSetViewModeTool } from './folders_set_view_mode.js';
import { tagsListTool } from './tags_list.js';
import { tagsCreateTool } from './tags_create.js';
import { tagsUpdateTool } from './tags_update.js';
import { tagsDeleteTool } from './tags_delete.js';
import { tasksListTool } from './tasks_list.js';
import { tasksMoveTool } from './tasks_move.js';
import { tasksClaimTool } from './tasks_claim.js';
import { tasksHistoryTool } from './tasks_history.js';
import { notesListAttachmentsTool } from './notes_list_attachments.js';
import { notesGetAttachmentTool } from './notes_get_attachment.js';
import { notesListActivityTool } from './notes_list_activity.js';
import { notesAddCommentTool } from './notes_add_comment.js';
import { notesUpdateCommentTool } from './notes_update_comment.js';
import { notesDeleteCommentTool } from './notes_delete_comment.js';
import { auditRecentTool } from './audit_recent.js';
import { moAskTool } from './mo/mo_ask.js';
import { moRememberTool } from './mo/mo_remember.js';
import { moForgetTool } from './mo/mo_forget.js';
import { moRequestHumanTool } from './mo/mo_request_human.js';
import { moSearchTool } from './mo/mo_search.js';
import { moPatrolTool } from './mo/mo_patrol.js';
import { moRegenerateClusterTool } from './mo/mo_regenerate_cluster.js';
import { moReclassifyTool } from './mo/mo_reclassify.js';
import { moAcknowledgeFindingTool } from './mo/mo_acknowledge_finding.js';
import { moListClustersTool } from './mo/mo_list_clusters.js';
import { moGetClusterTool } from './mo/mo_get_cluster.js';
import { moListTasksMetaTool } from './mo/mo_list_tasks_meta.js';
import { moResolveTaskTool } from './mo/mo_resolve_task.js';
import { moGetContextTool } from './mo/mo_get_context.js';
import { toolPlugins } from './plugins/index.js';

/**
 * Canonical ordered list of every MCP tool the server exposes. Order here
 * determines the order in which clients see tools in their tool list, which
 * matters for LLMs that scan top-down.
 *
 * Direction N — `tasks_*` + `folders_set_view_mode` are grouped together at
 * the end of the mutation block so an LLM discovering the tool list sees
 * the kanban primitives as one coherent surface, not scattered.
 *
 * Mo Context Broker (`01KQ0DYWC6PGQQ7EGAP3WCNJGF`): `mo_*` tools are
 * listed FIRST so an agent scanning top-down hits Mo as the recommended
 * entry point before the raw `notes_*` / `tasks_*` surface. Raw tools
 * remain available as the escape hatch for direct lookups by id and
 * ad-hoc user requests; routing between them is governed by repo
 * `CLAUDE.md` / `AGENTS.md` instructions, not by removing surface area.
 *
 * `CORE_TOOLS` is the always-on surface. Pluggable tools (auto-code:
 * `mo_check_workflow`, `workflows_list`) are appended from `toolPlugins`
 * — MASTER loads the auto-code plugin; the public OSS export loads none
 * (empty list from plugins/index.public.ts), dropping those two tools.
 * Appending keeps the core discovery order unchanged in both builds.
 */
const CORE_TOOLS: ToolDef<ZodRawShape>[] = [
  moGetContextTool,
  moAskTool,
  moSearchTool,
  moListClustersTool,
  moGetClusterTool,
  moListTasksMetaTool,
  moResolveTaskTool,
  moRememberTool,
  moForgetTool,
  moRequestHumanTool,
  moPatrolTool,
  moRegenerateClusterTool,
  moReclassifyTool,
  moAcknowledgeFindingTool,
  notesSearchTool,
  notesListTool,
  notesGetTool,
  notesCreateTool,
  notesUpdateTool,
  notesDeleteTool,
  notesAppendTool,
  notesDuplicateTool,
  notesMoveTool,
  notesRecentTool,
  foldersListTool,
  foldersCreateTool,
  foldersRenameTool,
  foldersDeleteTool,
  foldersDuplicateTool,
  foldersMoveTool,
  foldersReorderTool,
  foldersSetViewModeTool,
  tagsListTool,
  tagsCreateTool,
  tagsUpdateTool,
  tagsDeleteTool,
  tasksListTool,
  tasksMoveTool,
  tasksClaimTool,
  tasksHistoryTool,
  notesListAttachmentsTool,
  notesGetAttachmentTool,
  notesListActivityTool,
  notesAddCommentTool,
  notesUpdateCommentTool,
  notesDeleteCommentTool,
  auditRecentTool,
] as ToolDef<ZodRawShape>[];

export const ALL_TOOLS: ToolDef<ZodRawShape>[] = [
  ...CORE_TOOLS,
  ...toolPlugins.flatMap((p) => p.tools),
] as ToolDef<ZodRawShape>[];

export {
  moGetContextTool,
  moAskTool,
  moSearchTool,
  moListClustersTool,
  moGetClusterTool,
  moListTasksMetaTool,
  moResolveTaskTool,
  moRememberTool,
  moForgetTool,
  moRequestHumanTool,
  moPatrolTool,
  moRegenerateClusterTool,
  moReclassifyTool,
  moAcknowledgeFindingTool,
  notesCreateTool,
  notesGetTool,
  notesUpdateTool,
  notesDeleteTool,
  notesListTool,
  notesSearchTool,
  notesAppendTool,
  notesDuplicateTool,
  notesMoveTool,
  notesRecentTool,
  foldersListTool,
  foldersCreateTool,
  foldersRenameTool,
  foldersDeleteTool,
  foldersDuplicateTool,
  foldersMoveTool,
  foldersReorderTool,
  foldersSetViewModeTool,
  tagsListTool,
  tagsCreateTool,
  tagsUpdateTool,
  tagsDeleteTool,
  tasksListTool,
  tasksMoveTool,
  tasksClaimTool,
  tasksHistoryTool,
  notesListAttachmentsTool,
  notesGetAttachmentTool,
  notesListActivityTool,
  notesAddCommentTool,
  notesUpdateCommentTool,
  notesDeleteCommentTool,
  auditRecentTool,
};

