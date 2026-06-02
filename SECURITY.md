# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: GitHub → the repo's **Security** tab → **Report a vulnerability**
  (private advisory).
- Or email **mik@morion.ai**.

We aim to acknowledge within a few days. Please include repro steps and the
affected version.

## Supported versions

Only the latest release is supported. Fixes land on `main` and ship in the next
build.

## Threat model (read this before filing dependency advisories)

Morion is **local-first and single-user**. The HTTP/WebSocket server binds to
`127.0.0.1` (loopback) and, in browser-local mode, runs with no auth token by
design. There is no multi-tenant server, no remote attacker surface, and no
cloud component. Every input — notes, uploads, MCP calls — comes from the
machine's own user (or an LLM client that user wired up).

This materially lowers the real-world severity of several `npm audit`
advisories that assume a hostile remote client. We track them, but they are not
treated as launch blockers:

- **Transitive HTTP utils (`qs`, `ws`, etc.) — remote-DoS class.** Reachable
  only over loopback by the local user; resolved by routine `npm audit fix`.
- **`file-type` (malformed-media DoS via the upload validator).** The upload
  path is self-served (you would DoS your own local instance). A fix requires a
  major bump and is scheduled as a follow-up.
- **Dev toolchain (`esbuild` / `vite` / `vitest`) advisories**, incl. the
  esbuild dev-server one. These affect **development tooling only** — they are
  not present in the runtime the desktop app / sidecar ships. A `vite`/`vitest`
  major bump is scheduled separately.

If you find a vulnerability that **is** exploitable within this threat model
(e.g. an MCP actor escaping its permission scope, a path-traversal in
attachments, a sidecar auth bypass), please report it — those we treat as real.
