# How LLM memory works in Morion

This note was written by a human, but your LLM assistant can read and write notes too.

## What your LLM can do

When you connect Claude, Cursor, or another MCP client, it gets access to 22 tools:

- **Search** your notes with `notes_search` (hybrid keyword + semantic)
- **Create** notes with `notes_create` when you say "remember this"
- **Read** specific notes with `notes_get`
- **Organize** with folders and tags

## Try it

1. Open Settings (gear icon) and copy the Claude Desktop config snippet
2. Add it to your Claude Desktop MCP settings
3. Ask Claude: "What notes do I have in Morion?"
4. Ask Claude: "Remember that my preferred code review style is to focus on architecture, not formatting"

Claude will create a note you can see right here in the app.

## Why this matters

Unlike built-in LLM memory, your notes here are unlimited in size, searchable, editable, and shared across all your LLM clients. Your context lives in one place.
