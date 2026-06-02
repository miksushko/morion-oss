# Project ideas

A running list of things worth exploring.

## CLI dashboard for server metrics

Lightweight TUI that polls Prometheus endpoints and renders sparklines in the terminal. Could use `blessed` or `ink` for the rendering layer. Target audience: SREs who live in tmux.

## Markdown-to-slide-deck converter

Headings become slides, bullet points become content. Ship as a CLI that outputs a self-contained HTML file with keyboard navigation. No Electron, no server.

## Local-first budget tracker

SQLite + a simple web UI. Import bank CSVs, auto-categorize with rules, monthly summary view. The pitch: your finances stay on your machine.
