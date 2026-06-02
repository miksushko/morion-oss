import { describe, it, expect } from 'vitest';
import { formatActor } from '../src/web/src/lib/formatActor';

describe('formatActor', () => {
  it('returns "You" for the user actor', () => {
    expect(formatActor('user')).toBe('You');
  });

  it('maps known MCP clients to display names', () => {
    expect(formatActor('mcp:claude-desktop')).toBe('Claude Desktop');
    expect(formatActor('mcp:claude-code')).toBe('Claude Code');
    expect(formatActor('mcp:claude-ai')).toBe('Claude');
    expect(formatActor('mcp:cursor')).toBe('Cursor');
    expect(formatActor('mcp:cline')).toBe('Cline');
    expect(formatActor('mcp:zed')).toBe('Zed');
    expect(formatActor('mcp:windsurf')).toBe('Windsurf');
    expect(formatActor('mcp:antigravity')).toBe('Google Antigravity');
    expect(formatActor('mcp:codex')).toBe('Codex');
  });

  it('renders mcp:unknown as a generic label', () => {
    expect(formatActor('mcp:unknown')).toBe('Unknown MCP client');
  });

  it('title-cases unrecognised MCP slugs', () => {
    expect(formatActor('mcp:my-custom-thing')).toBe('My Custom Thing');
    expect(formatActor('mcp:cool_tool')).toBe('Cool Tool');
    expect(formatActor('mcp:singleword')).toBe('Singleword');
  });

  it('preserves strings that do not match the known prefixes (forward-compat)', () => {
    // A future actor kind like `user:alice@example.com` stays verbatim
    // rather than being mangled into `mcp:...` mapping territory.
    expect(formatActor('user:alice')).toBe('user:alice');
    expect(formatActor('system')).toBe('system');
  });
});
