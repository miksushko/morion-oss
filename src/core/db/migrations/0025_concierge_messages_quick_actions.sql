-- Mo Chat — quick-action buttons in Ask Mo messages.
--
-- Ticket: 01KQPBDGZBKKY98S8B96JPZ891
--
-- Discrete N-way choice presented to the user as buttons under an
-- assistant bubble (instead of "reply with `1: merge, 2: keep`"
-- text protocol that doesn't scale beyond 3 items). First consumer
-- is `runTopicHygiene` escalations; same surface will later carry
-- `mo_remember` conflict resolution + future approval prompts.
--
-- Two new columns on `concierge_messages`:
--
--   - `quick_actions` TEXT (JSON array, NULL on regular messages)
--     Set on ASSISTANT messages that ask for a discrete choice. Each
--     item: { id: string, label: string, kind:
--     'primary'|'secondary'|'destructive', payload: object }. The
--     payload carries everything the consumer route needs to apply
--     the action — producer + consumer share the schema by convention
--     per `payload.kind` (e.g. `cleanup-merge` carries
--     {source, target, folderId}).
--
--   - `replied_action_id` TEXT (NULL on assistant + organic-text user
--     messages). Set on USER messages that were created by clicking a
--     quick-action button. Matches the assistant message's
--     `quick_actions[].id` so the UI can collapse used vs unused
--     buttons (clicking "1:merge" on item 1 disables that item's
--     "1:keep" sibling but leaves "2:merge" / "2:keep" actionable).
--
-- Defaults: NULL on every legacy row. Quick actions are pure
-- additive — no behavioural change for messages that don't use them.

ALTER TABLE concierge_messages ADD COLUMN quick_actions TEXT;
ALTER TABLE concierge_messages ADD COLUMN replied_action_id TEXT;

CREATE INDEX IF NOT EXISTS idx_concierge_messages_replied_action
  ON concierge_messages(session_id, replied_action_id)
  WHERE replied_action_id IS NOT NULL;
