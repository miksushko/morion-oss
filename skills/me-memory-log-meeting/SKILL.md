---
name: me-memory-log-meeting
description: Capture meeting notes into the user's local Morion notebook with a consistent structure (attendees, agenda, decisions, action items). Use this whenever the user says "log this meeting", "save these meeting notes", "I just had a 1:1 with X", "write up the standup", or anything that maps to "turn this conversation/transcript into a structured meeting record".
---

# Log a meeting to Morion

The user runs a local notebook called **Morion** that doubles as an MCP memory server. This skill creates a single, well-structured meeting note.

## When to use

- "Log this meeting."
- "Write up the 1:1 with Alice."
- "Save these standup notes."
- "Capture the decisions from this discussion."
- After the user shares a transcript, raw notes, or a verbal recap of a meeting and expects it to be persisted.

## How to use

Call `notes_create` once with a structured markdown body. **Do not** spread the meeting across multiple notes — one meeting, one note.

```
notes_create({
  title: "<YYYY-MM-DD> — <topic or counterpart>",
  body: "<structured markdown — see template below>",
  tags: ["meeting", "<one tag for the topic or counterpart>"]
})
```

### Title format

`YYYY-MM-DD — <short topic>`. Examples:

- `2026-04-10 — 1:1 with Alice`
- `2026-04-10 — Backend standup`
- `2026-04-10 — Q2 planning`

The leading date makes meeting notes sort chronologically when listed by title.

### Body template

```markdown
## Attendees
- <name>, <name>

## Agenda
- <topic>
- <topic>

## Notes
- <bullet>
- <bullet>

## Decisions
- <decision> — <rationale>

## Action items
- [ ] <owner>: <action> — <due date if known>
- [ ] <owner>: <action>

## Open questions
- <question>
```

Skip any section that's empty — don't leave `## Decisions` with a placeholder. Empty sections are noise.

### Tags

Always include `meeting`. Add one more tag for the topic or counterpart:

- `1:1` for one-on-ones
- `standup` for standups
- `<project-name>` for project meetings
- `interview` for interviews

### Folder

If the user has a folder named `meetings`, `work`, or similar, call `folders_list` and place the note there. Otherwise leave `folderId: null`.

## After saving

Tell the user the note was saved with the exact title, and surface the action items as a quick recap so they can correct anything before the conversation ends.

## What not to do

- Do not call `notes_create` once per agenda item.
- Do not invent attendees, decisions, or action items the user did not mention.
- Do not paraphrase a verbatim quote when the exact wording is the load-bearing part (e.g., a commitment).
- Do not mark action items complete (`[x]`) — you're capturing the meeting, not running it.
