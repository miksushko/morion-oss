---
name: me-memory-remember
description: Save something to the user's local Morion notebook so future Claude conversations can recall it. Use this whenever the user says "remember", "save this", "note that", "log this", "add to my notes", or otherwise asks Claude to persist information for later. Works against the user's local SQLite notebook via the morion MCP server — no cloud, no account.
---

# Save to Morion

The user runs a local notebook called **Morion** that doubles as an MCP memory server. This skill saves a note into it.

## When to use

- "Remember that I prefer X."
- "Save this to my notes."
- "Note that the API key is in 1Password under foo."
- "Log this decision."
- After a conversation produces a durable fact, decision, or reference the user will want later — even without an explicit "remember" verb.

## How to use

Call the `notes_create` MCP tool. Required field is `title`; everything else is optional.

```
notes_create({
  title: "<short, concrete title under 80 chars>",
  body: "<full markdown content>",
  tags: ["<one or more topical tags>"],
  folderId: null
})
```

### Title rules

- Lead with the *subject*, not a verb. "Postgres timeout config" beats "Remember to set timeout".
- Concrete and searchable. Future-you will grep this. "Q2 budget approval — Slack #finance" beats "approval".
- Under 80 characters. Long titles get truncated in the notes list.
- No emojis.

### Body rules

- Markdown. Use headings, lists, code blocks freely.
- Include the *why*, not just the *what* — months later, the rationale is the load-bearing part.
- Cite the source if relevant: a URL, a Slack channel, a person's name, a file path.
- For code or commands, use fenced code blocks with the language.
- Don't paraphrase the user when an exact quote is more useful.

### Tags

- Lowercase, hyphenated, descriptive: `work`, `personal`, `decision`, `project-alpha`, `bug-report`.
- 1–4 tags is the sweet spot. Zero is fine for one-offs.
- Reuse existing tags when possible — call `tags_list` first if you're unsure.

### Folder

- Leave `folderId` as `null` (Inbox) unless the user explicitly names a folder, or unless you can confidently match the topic to an existing folder.
- Call `folders_list` to discover folders before guessing.

## After saving

Tell the user the note was saved and quote the exact title back so they know what to search for. Don't paraphrase. Example: `Saved to your notebook as "Postgres timeout config".`

## What not to do

- Do not call `notes_create` for transient conversation context that won't matter tomorrow.
- Do not call it twice for the same fact in one turn.
- Do not invent folder ids — only pass a folder id you got from `folders_list`.
- Do not include secrets the user did not explicitly ask you to store.
