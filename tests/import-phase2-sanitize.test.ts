import { describe, it, expect } from 'vitest';
import { sanitiseImportedHtml } from '../src/core/import/sanitize.js';

describe('sanitiseImportedHtml — script element strips', () => {
  it('strips <script> with content', () => {
    const r = sanitiseImportedHtml('Before<script>alert(1)</script>After');
    expect(r.body).not.toContain('<script');
    expect(r.body).not.toContain('alert(1)');
    expect(r.body).toBe('BeforeAfter');
    expect(r.removedCount).toBeGreaterThan(0);
  });

  it('strips multi-line <script> blocks', () => {
    const r = sanitiseImportedHtml(`# Title
<script>
  function pwn() { /* evil */ }
  pwn();
</script>
Text after`);
    expect(r.body).not.toContain('<script');
    expect(r.body).not.toContain('pwn()');
  });

  it('strips <iframe>', () => {
    const r = sanitiseImportedHtml('Pre<iframe src="evil.com"></iframe>Post');
    expect(r.body).not.toContain('<iframe');
  });

  it('strips <object>, <embed>, <form>, <input>, <button>', () => {
    const inputs = [
      '<object data="x">payload</object>',
      '<embed src="evil.swf">',
      '<form action="x"><input type="submit"></form>',
      '<button onclick="x()">Click</button>',
    ];
    for (const input of inputs) {
      const r = sanitiseImportedHtml(input);
      expect(r.body).not.toMatch(/<(object|embed|form|input|button)/i);
    }
  });

  it('strips self-closing void variants', () => {
    const r = sanitiseImportedHtml('<input type="text" /><link rel="stylesheet" href="x">');
    expect(r.body).not.toContain('<input');
    expect(r.body).not.toContain('<link');
  });

  it('strips <style>, <link>, <meta>, <noscript>', () => {
    const r = sanitiseImportedHtml(
      '<style>body{display:none}</style><link href="x"><meta name="y"><noscript>foo</noscript>',
    );
    expect(r.body).toBe('');
  });
});

describe('sanitiseImportedHtml — event handler attribute strips', () => {
  it('strips onclick / onmouseover / onerror', () => {
    const r = sanitiseImportedHtml('<a href="x" onclick="alert(1)">link</a>');
    expect(r.body).not.toContain('onclick');
    expect(r.body).toContain('href="x"');
    expect(r.body).toContain('link');
  });

  it('strips multiple handlers in one tag', () => {
    const r = sanitiseImportedHtml(
      '<a href="x" onclick="a()" onmouseover="b()" onerror="c()">link</a>',
    );
    expect(r.body).not.toContain('onclick');
    expect(r.body).not.toContain('onmouseover');
    expect(r.body).not.toContain('onerror');
  });

  it('strips handler with single quotes', () => {
    const r = sanitiseImportedHtml(`<img src='x' onerror='alert(1)'>`);
    expect(r.body).not.toContain('onerror');
  });

  it('strips unquoted handler value', () => {
    const r = sanitiseImportedHtml('<a onclick=alert(1) href="x">link</a>');
    expect(r.body).not.toContain('onclick');
  });
});

describe('sanitiseImportedHtml — URI scheme strips', () => {
  it('replaces javascript: in href', () => {
    const r = sanitiseImportedHtml('<a href="javascript:alert(1)">click</a>');
    expect(r.body).not.toContain('javascript:');
    expect(r.body).toContain('#blocked:');
  });

  it('replaces vbscript: in href', () => {
    const r = sanitiseImportedHtml('<a href="vbscript:msgbox 1">click</a>');
    expect(r.body).not.toContain('vbscript:');
  });

  it('replaces data:text/html', () => {
    const r = sanitiseImportedHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(r.body).not.toContain('data:text/html');
  });
});

describe('sanitiseImportedHtml — CSS expression strips', () => {
  it('removes expression() in style attr', () => {
    const r = sanitiseImportedHtml(
      '<div style="color: red; width: expression(alert(1))">x</div>',
    );
    expect(r.body).not.toContain('expression(');
  });
});

describe('sanitiseImportedHtml — keep safe HTML', () => {
  it('keeps <br>, <sub>, <sup>, <details>, <summary>, <ins>, <del>', () => {
    const safe =
      '<br><sub>x</sub><sup>y</sup><details><summary>z</summary>q</details><ins>i</ins><del>d</del>';
    const r = sanitiseImportedHtml(safe);
    // None of these tags are in the strip list, so they should be preserved.
    expect(r.body).toContain('<br>');
    expect(r.body).toContain('<sub>');
    expect(r.body).toContain('<sup>');
    expect(r.body).toContain('<details>');
  });

  it('keeps <a>, <img>, <code> when content is safe', () => {
    const r = sanitiseImportedHtml(
      '<a href="https://example.com">link</a><img src="x.png" alt="x"><code>foo()</code>',
    );
    expect(r.body).toContain('<a href="https://example.com">');
    expect(r.body).toContain('<img');
    expect(r.body).toContain('<code>');
  });

  it('keeps HTML comments', () => {
    const r = sanitiseImportedHtml('<!-- mo:section-start id="overview" -->\nbody');
    expect(r.body).toContain('<!-- mo:section-start');
  });
});

describe('sanitiseImportedHtml — markdown code regions preserved', () => {
  it('does not strip <Button> from a fenced code block', () => {
    const input = '\n```tsx\n<Button variant="primary">click</Button>\n```\n';
    const r = sanitiseImportedHtml(input);
    expect(r.body).toContain('<Button variant="primary">click</Button>');
  });

  it('does not strip <style> from a fenced code block', () => {
    const input = 'No `<style>` tag, no Emotion serialization';
    const r = sanitiseImportedHtml(input);
    expect(r.body).toBe('No `<style>` tag, no Emotion serialization');
  });

  it('does not strip event handlers from inline code', () => {
    const input = 'Use `onClick="alert(1)"` like this';
    const r = sanitiseImportedHtml(input);
    expect(r.body).toContain('`onClick="alert(1)"`');
  });

  it('still strips <script> outside code blocks even when code blocks are present', () => {
    const input = 'Bad: <script>alert(1)</script>\n```\nfine: <script>x</script>\n```\nMore <script>y</script>';
    const r = sanitiseImportedHtml(input);
    // <script> in code block survives
    expect(r.body).toContain('```\nfine: <script>x</script>\n```');
    // <script> outside is stripped
    expect(r.body).not.toContain('Bad: <script');
    expect(r.body).not.toContain('More <script');
  });

  it('preserves consecutive code blocks separated by prose', () => {
    const input = '```\n<style>a</style>\n```\nbetween\n```\n<button>b</button>\n```';
    const r = sanitiseImportedHtml(input);
    expect(r.body).toContain('<style>a</style>');
    expect(r.body).toContain('<button>b</button>');
    expect(r.body).toContain('between');
  });
});

describe('sanitiseImportedHtml — OWASP-style payloads', () => {
  it.each([
    '<scr<script>ipt>alert(1)</script>',
    '<SCRIPT>alert(1)</SCRIPT>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<a href="javascript:void(0)" onclick="alert(1)">x</a>',
    '<iframe srcdoc="<script>alert(1)</script>">',
    '<body onload=alert(1)>',
    '<input onfocus=alert(1) autofocus>',
  ])('payload %# is rendered safe', (payload) => {
    const r = sanitiseImportedHtml(payload);
    // Specific success criteria for these inputs:
    //   - no <script> tag remaining (case-insensitive)
    //   - no `on<word>=` attribute remaining
    //   - no `javascript:` scheme remaining
    expect(r.body.toLowerCase()).not.toMatch(/<script[\s>]/);
    expect(r.body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(r.body.toLowerCase()).not.toContain('javascript:');
  });
});
