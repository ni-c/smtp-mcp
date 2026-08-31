import { describe, expect, it } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import { htmlToText, sanitizeHtml } from '../src/sanitize.js';

describe('sanitizeHtml', () => {
  it('leaves ordinary markup alone', () => {
    const input = '<p>Hello <b>Anna</b></p><p>Regards</p>';
    const result = sanitizeHtml(input);
    expect(result.html).toBe(input);
    expect(result.removed).toEqual([]);
  });

  it('removes a script element with its contents', () => {
    const result = sanitizeHtml('<p>a</p><script>steal()</script><p>b</p>');
    expect(result.html).not.toMatch(/steal/);
    expect(result.html).toBe('<p>a</p><p>b</p>');
    expect(result.removed).toContain('<script> element');
  });

  it('removes an unclosed script tag too', () => {
    const result = sanitizeHtml(
      '<p>a</p><script src="https://x.example/s.js">'
    );
    expect(result.html).not.toMatch(/script/i);
    expect(result.removed.join(' ')).toMatch(/script/);
  });

  it('removes event handlers in every quoting style', () => {
    const result = sanitizeHtml(
      `<div onclick="a()" onmouseover='b()' onload=c()>x</div>`
    );
    expect(result.html).not.toMatch(/onclick|onmouseover|onload/);
    expect(result.html).toContain('<div>x</div>');
    expect(result.removed).toContain('click handler');
  });

  it('removes a remotely loaded image, which is how a tracking pixel works', () => {
    const result = sanitizeHtml(
      '<p>hi</p><img src="https://tracker.example/p.gif?u=anna" width="1">'
    );
    expect(result.html).toBe('<p>hi</p>');
    expect(result.removed).toContain('remotely loaded <img> (tracking risk)');
  });

  it('removes a protocol-relative image source as well', () => {
    const result = sanitizeHtml('<img src="//tracker.example/p.gif">');
    expect(result.html).toBe('');
  });

  it('keeps links, which fetch nothing on their own', () => {
    const result = sanitizeHtml('<a href="https://example.net/x">click</a>');
    expect(result.html).toContain('href="https://example.net/x"');
    expect(result.removed).toEqual([]);
  });

  it('strips a javascript: URL but keeps the element', () => {
    const result = sanitizeHtml('<a href="javascript:steal()">click</a>');
    expect(result.html).not.toMatch(/javascript:/);
    expect(result.removed).toContain('javascript: URL in href');
  });

  it('sees through whitespace and control characters in a scheme', () => {
    // "java\tscript:" is javascript: to a browser, so it has to be one here.
    const result = sanitizeHtml('<a href="java\tscript:steal()">click</a>');
    expect(result.html).not.toMatch(/steal/);
  });

  it('strips a data: URL', () => {
    const result = sanitizeHtml(
      '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'
    );
    expect(result.html).not.toMatch(/data:/);
  });

  it('neutralises url() inside a style attribute', () => {
    const result = sanitizeHtml(
      `<div style="background:url('https://tracker.example/p.gif')">x</div>`
    );
    expect(result.html).not.toMatch(/tracker\.example/);
    expect(result.removed).toContain('url() in a style attribute');
  });

  it('drops iframes, objects and forms with their contents', () => {
    const result = sanitizeHtml(
      '<iframe src="https://x.example"></iframe><object data="x"></object><form action="https://x.example"><input name="a"></form>'
    );
    expect(result.html.replace(/\s/g, '')).toBe('');
  });

  it('refuses an over-long body rather than truncating it', () => {
    // Half a message is worse than an error: it would arrive looking deliberate.
    expect(() => sanitizeHtml('<p>x</p>'.repeat(100_000))).toThrow(
      ToolInputError
    );
    expect(() => sanitizeHtml('<p>x</p>'.repeat(100_000))).toThrow(
      /over the limit/
    );
  });

  it('reports each kind of removal once, not once per occurrence', () => {
    const result = sanitizeHtml(
      '<img src="https://a.example/1.gif"><img src="https://a.example/2.gif">'
    );
    expect(result.removed.filter((r) => r.includes('<img>')).length).toBe(1);
  });
});

describe('htmlToText', () => {
  it('turns block structure into line breaks', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('drops non-content elements entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>text</p>')).toBe('text');
    expect(htmlToText('<script>steal()</script><p>text</p>')).toBe('text');
  });

  it('decodes the entities a reader would otherwise see raw', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>')).toBe(
      'a & b <c> "d"'
    );
  });

  it('collapses the whitespace that tag removal leaves behind', () => {
    expect(htmlToText('<div>  a   <span>b</span>  </div>')).toBe('a b');
  });
});

describe('malformed markup cannot stall the event loop', () => {
  // These are timings, which is unusual in a unit suite and deliberate here.
  // The patterns are bounded but were not linear: `<img ` repeated with no `>`
  // made every window run at every position, and a 500 kB body took fourteen
  // seconds of blocked event loop — through preview_mail, which needs no send
  // gate, no confirmation and no rate limit. The bound is generous enough not
  // to be flaky on a loaded machine and far below the failure it guards.
  const BUDGET_MS = 400;

  const pathological: Array<[string, string]> = [
    ['unclosed img tags', '<img '.repeat(12800)],
    ['unclosed script tags', '<script '.repeat(8000)],
    ['unterminated comments', '<!--'.repeat(16000)],
    ['nothing but angle brackets', '<'.repeat(64000)],
    ['many opens and one close', '<script >'.repeat(7000) + '</script>'],
  ];

  for (const [name, input] of pathological) {
    it(`sanitizes ${name} promptly`, () => {
      const started = process.hrtime.bigint();
      sanitizeHtml(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(ms).toBeLessThan(BUDGET_MS);
    });

    it(`converts ${name} to text promptly`, () => {
      const started = process.hrtime.bigint();
      htmlToText(input);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it('refuses a body over the ceiling rather than working on it', () => {
    expect(() => sanitizeHtml('x'.repeat(64_001))).toThrow(/over the limit/);
  });
});
