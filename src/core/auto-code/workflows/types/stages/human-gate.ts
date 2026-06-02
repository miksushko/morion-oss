import { z } from 'zod';

/** Human In The Loop stage (Editor Model v2 spec, Morion note
 *  01KRAQWPXR5AYTFVF6J12TYHJ1, refined 2026-05-11):
 *
 *    "Human In The Loop имеет только одну точку входа и выхода. На
 *    один Mo статус можно сбоку подключить один Mo Human Loop. Сам
 *    по себе Human Loop не делает никаких действий — это просто
 *    диалог, где пользователь что-то пишет текстом (в том числе
 *    решения), а по выходу Mo уже делает действия."
 *
 *  Single in / single out. The stage suspends the run, posts the
 *  `prompt` to the per-ticket chat, and waits for the user's free-
 *  text reply. The reply is appended to the ticket context for the
 *  next stage (typically the same Mo decision node that asked the
 *  question). Mo re-evaluates with the new context and picks its
 *  branch on its next turn — Human Loop itself doesn't decide /
 *  branch; routing decisions live on Mo.
 *
 *  `options` is preserved as an OPTIONAL legacy field so historical
 *  rows (which used it for quick-action buttons) still parse, but
 *  the runtime + editor ignore it. The v2 superRefine block treats
 *  human_gate as a single-output stage (exactly one outbound edge),
 *  NOT as a multi-out routing node. */
export const HumanGateStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('human_gate'),
  /** Optional workflow-author hint to Mo about WHAT to ask the user
   *  when this stage fires (e.g. "ask about which design variant"
   *  or "confirm the user wants to drop the legacy fallback"). Mo
   *  composes the actual chat opening message at runtime by reading
   *  the ticket + recent comments + prior stage outputs + this hint.
   *  Empty / absent = Mo composes purely from context.
   *
   *  Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA, 2026-05-13)
   *  — replaces the legacy `prompt: string` field which was a static
   *  literal posted verbatim to chat (bypassing Mo's role as
   *  conversational lead). The legacy `prompt` field is accepted on
   *  input for back-compat — both fields parse — but the runner
   *  reads `guidance ?? prompt` so legacy rows still flow through. */
  guidance: z.string().optional(),
  /** Legacy field — accepted on input so v1 workflow rows still
   *  parse. Runtime reads `guidance ?? prompt` (see
   *  `humanGateGuidance` helper below). New saves shouldn't emit
   *  this field; the editor surfaces `guidance` only. */
  prompt: z.string().optional(),
  /** Deprecated — kept optional so legacy rows parse. Treat as
   *  display-only metadata; routing happens on the downstream Mo
   *  stage, not via option-button picks. */
  options: z.array(z.string()).optional().default([]),
});

/** Resolve the workflow-author's chat-opening hint, falling back to
 *  the legacy `prompt` field for v1 rows. Runtime callers MUST use
 *  this helper so the v2 → v1 fallback is consistent across runner,
 *  factory humanGateHandler, and the chat-route Mo composer. */
export function humanGateGuidance(
  stage: { guidance?: string; prompt?: string },
): string | undefined {
  return stage.guidance ?? stage.prompt;
}
