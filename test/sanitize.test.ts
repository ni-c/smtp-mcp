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

describe('a "<" inside an attribute value', () => {
  // The attribute part used to be `[^<>]`, which excludes the very character
  // being smuggled: the pattern never reached the closing `>`, the opening tag
  // did not match, and only `</script>` was removed — while the dialog reported
  // a `<script>` tag had been taken out. False assurance and live script in the
  // same message.

  it('does not let a script element through the block pattern', () => {
    const result = sanitizeHtml(
      '<p>hi</p><script a="<">fetch("https://evil.example/x")</script>'
    );
    expect(result.html).toBe('<p>hi</p>');
    expect(result.html).not.toMatch(/script/i);
    expect(result.html).not.toContain('evil.example');
    expect(result.removed).toContain('<script> element');
  });

  it('does not let a tracking pixel through the subresource pattern', () => {
    const result = sanitizeHtml(
      '<img alt="<" src="https://tracker.example/p.gif?u=anna">'
    );
    expect(result.html).not.toContain('tracker.example');
    expect(result.removed.join(' ')).toMatch(/tracking risk/);
  });

  it('handles the whole reported payload in one go', () => {
    const result = sanitizeHtml(
      '<p>hi</p><script a="<">fetch("https://evil.example/x")</script>' +
        '<img alt="<" src="https://tracker.example/p.gif?u=anna">'
    );
    expect(result.html).toBe('<p>hi</p>');
  });

  it('keeps a single quoted attribute intact', () => {
    const result = sanitizeHtml(`<img alt='<' src="/local.gif">`);
    expect(result.html).toContain('src="/local.gif"');
  });
});

describe('markup that cannot be cleaned with confidence is refused', () => {
  // Refusing is the right failure for outgoing text. A message that never left
  // can be fixed; a message that arrived with a script in it cannot be recalled.

  it('refuses rather than sending a script tag it could not remove', () => {
    // An unterminated attribute quote: no pattern here can find the tag's end.
    expect(() => sanitizeHtml('<p>a</p><script a="')).toThrow(ToolInputError);
    expect(() => sanitizeHtml('<p>a</p><script a="')).toThrow(
      /still contains a <script> tag/
    );
  });

  it('refuses each of the elements that must never survive', () => {
    for (const tag of [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'applet',
      'form',
      'svg',
      'math',
    ]) {
      expect(() => sanitizeHtml(`<${tag} a="`)).toThrow(/still contains/);
    }
  });

  it('never reports a removal for a message it went on to send', () => {
    // The assurance the dialog makes: "removed before sending" can only name
    // something that is really gone, because anything left refuses the message.
    const result = sanitizeHtml(
      '<p>a</p><script>steal()</script><iframe src="https://x.example"></iframe>'
    );
    for (const tag of ['script', 'iframe']) {
      if (result.removed.some((entry) => entry.includes(`<${tag}>`))) {
        expect(result.html).not.toMatch(
          new RegExp(`<\\s*/?\\s*${tag}\\b`, 'i')
        );
      }
    }
  });

  it('leaves an escaped mention of a tag alone', () => {
    const result = sanitizeHtml('<p>use the &lt;script&gt; element</p>');
    expect(result.html).toBe('<p>use the &lt;script&gt; element</p>');
  });
});

describe('remote subresources beyond src', () => {
  // Each of these is a counter: it reports the moment a message was opened,
  // from which address, and how often.

  it('removes an image loaded through srcset, which \\bsrc never matched', () => {
    const result = sanitizeHtml(
      '<img srcset="https://tracker.example/p.gif 1x">'
    );
    expect(result.html).not.toContain('tracker.example');
    expect(result.removed.join(' ')).toMatch(/tracking risk/);
  });

  it('checks every candidate of a srcset descriptor list, not just the first', () => {
    const result = sanitizeHtml(
      '<img srcset="/local.gif 1x, https://tracker.example/p.gif 2x">'
    );
    expect(result.html).not.toContain('tracker.example');
  });

  it('removes imagesrcset as well', () => {
    const result = sanitizeHtml(
      '<img imagesrcset="https://tracker.example/p.gif 2x">'
    );
    expect(result.html).not.toContain('tracker.example');
  });

  it('removes a remote video poster', () => {
    const result = sanitizeHtml(
      '<video poster="https://tracker.example/p.gif"></video>'
    );
    expect(result.html).not.toContain('tracker.example');
  });

  it('removes a background attribute without deleting the element', () => {
    // `background` sits on `<body>` and `<table>`, which are not fetch-on-open
    // elements — dropping the whole element would gut the message.
    const result = sanitizeHtml(
      '<table background="https://tracker.example/p.gif"><tr><td>x</td></tr></table>'
    );
    expect(result.html).not.toContain('tracker.example');
    expect(result.html).toContain('<td>x</td>');
    expect(result.removed.join(' ')).toMatch(/background/);
  });

  it('removes a body background too', () => {
    const result = sanitizeHtml(
      '<body background="//tracker.example/p.gif"><p>hi</p></body>'
    );
    expect(result.html).not.toContain('tracker.example');
    expect(result.html).toContain('<p>hi</p>');
  });

  it('leaves a local srcset and a local poster alone', () => {
    const result = sanitizeHtml(
      '<img srcset="cid:logo 1x"><video poster="cid:cover"></video>'
    );
    expect(result.html).toContain('cid:logo');
    expect(result.html).toContain('cid:cover');
    expect(result.removed).toEqual([]);
  });

  it('reaches every quoting style, not only the double-quoted one', () => {
    // Single-quoted and unquoted attributes are what a model writes when it is
    // copying markup from somewhere, and a check that only understood one of
    // the three would be a check with two ways round it.
    for (const attribute of [
      `src='https://tracker.example/p.gif'`,
      'src=https://tracker.example/p.gif',
      `srcset='https://tracker.example/p.gif 1x'`,
      'srcset=https://tracker.example/p.gif',
    ]) {
      expect(sanitizeHtml(`<img ${attribute}>`).html).not.toContain(
        'tracker.example'
      );
    }
    for (const attribute of [
      `background='https://tracker.example/p.gif'`,
      'background=https://tracker.example/p.gif',
    ]) {
      const result = sanitizeHtml(`<table ${attribute}><td>x</td></table>`);
      expect(result.html).not.toContain('tracker.example');
      expect(result.html).toContain('<td>x</td>');
    }
  });

  it('strips an unsafe scheme in every quoting style too', () => {
    for (const attribute of [
      `href='javascript:steal()'`,
      'href=javascript:steal()',
    ]) {
      const result = sanitizeHtml(`<a ${attribute}>click</a>`);
      expect(result.html).not.toMatch(/javascript:/);
      expect(result.removed).toContain('javascript: URL in href');
    }
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
    // The shapes the quoted-string alternative added. An alternation where a
    // quote can also be read as an ordinary character is the classic way to
    // reintroduce catastrophic backtracking, so each spelling is timed.
    ['unterminated attribute quotes', '<img src="'.repeat(6400)],
    ['closed attribute quotes', '<img a="b" '.repeat(5818)],
    ['a quote that never closes', `<img a="${'x'.repeat(63000)}`],
    ['alternating quote styles', `<img a="b" c='d' `.repeat(3764)],
  ];

  for (const [name, input] of pathological) {
    it(`sanitizes ${name} promptly`, () => {
      const started = process.hrtime.bigint();
      // Timing is the assertion, not the outcome: several of these are now
      // refused outright by the final check, which is a different guarantee
      // and has its own tests.
      try {
        sanitizeHtml(input);
      } catch {
        /* the refusal is timed too */
      }
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
