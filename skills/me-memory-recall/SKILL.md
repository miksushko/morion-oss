---
name: me-memory-recall
description: Look something up in the user's local Morion notebook. Use this whenever the user references prior knowledge that might be in their notes — "what did I write about X", "do I have notes on Y", "remind me of the Z decision", or any time the user expects Claude to know something it could only know from a personal note. Hybrid keyword + semantic search runs locally against SQLite.
---

# Recall from Morion

The user runs a local notebook called **Morion** that doubles as an MCP memory server. This skill searches it.

## When to use

- "What did I write about postgres timeouts?"
- "Remind me what we decided about the Q2 budget."
- "Do I have notes on the alpha launch?"
- Before answering anything where the user might reasonably have personal context Claude couldn't know — even without an explicit "search my notes" instruction.
- At the start of a session about a recurring topic, to load relevant context.

## How to use

Call the `notes_search` MCP tool. It runs hybrid BM25 + vector search and returns ranked hits with snippets.

```
notes_search({ query: "<free-form query>", limit: 10 })
```

### Query rules

- Use the user's words first. "postgres timeout" before "database connection settings".
- Multiple words rank together. Three-to-six word queries usually beat one-word queries.
- If the first query returns nothing useful, *iterate*: try synonyms, broader terms, related concepts. The vector store handles paraphrases reasonably well, but you still need to give it something to anchor on.
- Do not pre-filter aggressively. Search wide, then narrow.

### Reading hits

Each hit has `id`, `title`, `snippet`, `score`, and `tags`. The snippet has search-term highlights wrapped in `<mark>` tags — strip them before quoting.

If a hit looks promising but the snippet is cut off, call `notes_get({ id })` to fetch the full body.

## When to escalate

- If `notes_search` returns nothing on multiple rephrasings, fall back to `notes_list({ folderId, limit })` to browse a folder, or `tags_list` to discover what topics exist.
- If the user mentions a folder by name, call `folders_list` first, find the folder id, then `notes_list({ folderId })`.

## After recalling

- Quote the relevant note back to the user — title plus the load-bearing line(s).
- Cite the note title so the user knows where it came from.
- Do not summarise multiple notes into one paragraph and lose attribution. One note = one citation.

## What not to do

- Do not invent answers when search returns nothing. Say "I didn't find anything in your notes about X" and offer to add one.
- Do not call `notes_search` more than 4–5 times per turn — if you've genuinely struck out, stop and tell the user.
- Do not pass a folder id you didn't get from `folders_list`.
