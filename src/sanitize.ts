import { ToolInputError } from './errors.js';
import { MAX_HTML_CHARS as SCHEMA_MAX_HTML_CHARS } from './schema.js';

/**
 * Upper bound on an HTML body.
 *
 * Note that this **refuses** rather than truncating. Everywhere else in this
 * server an over-long string is cut short, because the reader is a model and
 * half the text is better than none. Here the reader is a recipient, and half a
 * message is worse than an error: it would arrive looking deliberate.
 */
const MAX_HTML_CHARS = SCHEMA_MAX_HTML_CHARS;
/**
 * Bounds each removal regex.
 *
 * Bounded is not the same as linear, and that difference was a real finding.
 * `<img ` repeated 100 000 times contains no `>`, so a pattern whose attribute
 * part was `[^>]*` scanned to the end of the string from every one of those
 * positions: 14 seconds of blocked event loop, reachable through `preview_mail`
 * with sending switched off. Two changes together fix it — the attribute and
 * tag-name parts below exclude `<` as well as `>`, so a malformed run fails at
 * the very next character instead of scanning, and the window is small enough
 * that the remaining quadratic case (many opening tags, no closing one) stays
 * in single-digit milliseconds against the 64 kB input ceiling.
 *
 * `test/sanitize.test.ts` asserts the timing, because this is the kind of
 * property that regresses silently the next time a pattern is edited.
 */
const MAX_BLOCK_CHARS = 4_000;

/**
 * The attribute part of a tag pattern.
 *
 * `[^<>]{0,2000}` on its own was a real hole rather than a rough edge. A `<`
 * inside an attribute *value* is excluded by that class, so on
 * `<script a="<">steal()</script>` the pattern never reached the closing `>`
 * and the **opening** tag did not match at all — only `</script>` did. The
 * script went out with the operator's DKIM signature while the confirmation
 * dialog told the human a `<script>` tag had been removed, which is the worst
 * possible combination: a false assurance exactly where nothing was neutralised.
 *
 * So a quoted string is its own alternative, and a `<` inside one no longer
 * ends the tag. The unquoted alternative excludes both quote characters as well
 * as the brackets, which is not cosmetic: it means exactly one alternative can
 * begin at any given character. An ambiguous alternation — one where `"abc"`
 * can be read either as a quoted string or as five separate characters — is how
 * the ReDoS this file already fixed once comes back, because every failure to
 * find the closing `>` would then be retried in exponentially many ways.
 *
 * Both repetitions stay bounded, for the reason the note above gives.
 */
const ATTRS = String.raw`(?:"[^"]{0,2000}"|'[^']{0,2000}'|[^"'<>]){0,2000}`;

/**
 * The elements that may not survive, in one list.
 *
 * The two removal patterns below and the final refusal check are all built from
 * it. The refusal check used to carry a *shorter* list, and that gap was a
 * hole: `<link a=b<c rel=stylesheet href=https://…>` fails the tag pattern (the
 * unquoted `<` ends the attribute run), was not on the refusal list, and so went
 * out whole — a remote stylesheet fetch, which is a beacon. Anything a pass
 * tries to remove is something the message must not leave with.
 */
const BLOCK_ELEMENTS =
  'script|style|iframe|object|embed|applet|noscript|template|form|svg|math';
const VOID_ELEMENTS = 'base|link|meta|frame|frameset';

/** Elements dropped together with their contents. */
const DANGEROUS_BLOCK = new RegExp(
  `<(${BLOCK_ELEMENTS})\\b${ATTRS}>[\\s\\S]{0,${MAX_BLOCK_CHARS}}?<\\/\\1\\s*>`,
  'gi'
);
/** The same elements when they are left unclosed, plus the void ones. */
const DANGEROUS_VOID = new RegExp(
  `<\\/?(${BLOCK_ELEMENTS}|${VOID_ELEMENTS})\\b${ATTRS}>`,
  'gi'
);

/**
 * Where an attribute may begin.
 *
 * `\s` alone was the hole. An HTML tokenizer starts a new attribute after
 * whitespace, but also directly after a `/` and directly after the closing
 * quote of the previous value: `<img/src=…>` and `<img alt="x"src=…>` both carry
 * a `src`, and every attribute pattern below used to look for a space in front
 * of the name and so saw neither. A tracking pixel written either way went out
 * with the operator's DKIM signature while the dialog reported nothing removed.
 *
 * Whitespace is consumed so the removal does not leave a stray space behind;
 * the other two boundaries are matched with a lookbehind so the character
 * itself — which belongs to the previous attribute — stays where it is.
 */
const ATTR_START = String.raw`(?:\s+|(?<=[/"']))`;

/** An attribute value in any of the three quoting styles. */
const ATTR_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s<>]+))`;

/**
 * Elements a mail client fetches on its own. Removing them is the difference
 * between a message and a beacon: a 1×1 image tells the sender when, where and
 * how often the recipient opened their mail, and this server should not be the
 * easy way to add one.
 *
 * Links are deliberately left alone — they are click-only, they fetch nothing
 * by themselves, and an HTML mail without links is not worth sending.
 */
const REMOTE_SUBRESOURCE = new RegExp(
  `<(img|image|input|video|audio|source|track|iframe)\\b${ATTRS}>`,
  'gi'
);

/**
 * Attributes a client resolves and fetches without being clicked.
 *
 * `\bsrc` was the whole list and it was too short in two directions.
 * `srcset` is not matched by `\bsrc` at all — `<img srcset="https://…/p.gif 1x">`
 * is a tracking pixel that walked straight through — and `poster` and
 * `background` were only ever checked for an unsafe *scheme*, which `https:` is
 * not. `<video poster>`, `<body background>` and `<table background>` are each a
 * counter that reports the moment a message is opened, from where, and how
 * often.
 *
 * `srcset` and `imagesrcset` carry a comma-separated candidate list with size
 * descriptors, so every candidate is checked rather than the attribute value as
 * a whole.
 */
const SUBRESOURCE_URL_ATTRIBUTE = new RegExp(
  `${ATTR_START}(src|srcset|imagesrcset|poster|background)\\s*=\\s*${ATTR_VALUE}`,
  'gi'
);

/** Attributes that run script when the recipient does anything at all. */
const EVENT_HANDLER = new RegExp(
  `${ATTR_START}on[a-z]{1,20}\\s*=\\s*${ATTR_VALUE}`,
  'gi'
);

/** URL-valued attributes whose scheme has to be checked. */
const URL_ATTRIBUTE = new RegExp(
  `${ATTR_START}(href|src|action|formaction|data|poster|background|cite)\\s*=\\s*${ATTR_VALUE}`,
  'gi'
);

/**
 * Inline styles, checked as a whole.
 *
 * A style attribute is a second language inside the first, with its own
 * escaping: `u\72l(` is `url(` to a CSS parser, and `image-set()` fetches just
 * as `url()` does. So the value is decoded the way a CSS parser would decode it
 * and searched for anything that fetches; if it does, the attribute goes,
 * because there is no honest way to keep half a declaration.
 */
const STYLE_ATTRIBUTE = new RegExp(
  `${ATTR_START}style\\s*=\\s*${ATTR_VALUE}`,
  'gi'
);
const CSS_FETCH = /(?:\burl|\bimage-set|\bimage|\bsrc)\s*\(|@import\b/i;

/**
 * What must not be in the finished string, whatever the passes above did.
 *
 * This one **refuses** rather than repairing, and that is the point of it.
 * Every pattern in this file is a regex over markup that the recipient's client
 * will hand to a real parser, and the two can always be made to disagree
 * somewhere; the question is only what happens on the day they do. For an
 * outgoing message the safe direction is to stop: a message that never left can
 * be fixed, a message that arrived carrying a script cannot be recalled.
 *
 * It also makes {@link SanitizedHtml.removed} honest. That list is shown to the
 * human as "removed before sending", and the only way it can name something
 * that is still in the message is if the message is not sent at all.
 */
const FORBIDDEN_AFTER_SANITIZING = new RegExp(
  `<\\s*\\/?\\s*(${BLOCK_ELEMENTS}|${VOID_ELEMENTS})\\b`,
  'i'
);

/** `url(...)` anywhere at all — the net under the style-attribute pass. */
const CSS_URL = /url\s*\(\s*(['"]?)[^)'"]{0,2000}\1\s*\)/gi;

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:', 'cid:'];

/**
 * The named character references that can spell a scheme or a separator.
 *
 * Not the whole HTML5 table — only what can turn a harmless-looking value into
 * `https://` or `javascript:` once the client decodes it. Being too eager here
 * costs a removal; being too lax is the hole.
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  bsol: '\\',
  num: '#',
  period: '.',
  tab: '\t',
  newline: '\n',
  nbsp: ' ',
};

/**
 * Decodes character references the way an attribute value is decoded before a
 * client reads it as a URL.
 *
 * `&#104;ttps://` and `https&colon;//` are `https://` to every mail client, and
 * `&#106;avascript:` is `javascript:`; none of them contains a scheme until
 * this has run. Numeric references decode with or without the semicolon, as
 * the HTML tokenizer does in an attribute. Named ones need it, except the few
 * legacy names that never did.
 */
export function decodeReferences(value: string): string {
  return value
    .replace(/&#[xX]([0-9a-fA-F]{1,6});?/g, (_m, hex: string) =>
      codePoint(parseInt(hex, 16))
    )
    .replace(/&#([0-9]{1,7});?/g, (_m, dec: string) =>
      codePoint(parseInt(dec, 10))
    )
    .replace(
      /&([a-zA-Z]{1,8})(;?)/g,
      (match, name: string, terminator: string) => {
        const decoded = NAMED_REFERENCES[name.toLowerCase()];
        if (decoded === undefined) return match;
        // Without the semicolon only the legacy names decode.
        if (terminator === '' && !/^(amp|lt|gt|quot)$/i.test(name)) {
          return match;
        }
        return decoded;
      }
    );
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return '';
  return String.fromCodePoint(value);
}

/**
 * Decodes CSS escapes: `\72` is `r`, `\0072 ` is `r`, and a backslash before a
 * non-hex character is that character. A style attribute is decoded once as
 * HTML and once as CSS, in that order, because that is the order a client
 * applies.
 */
export function decodeCssEscapes(value: string): string {
  return decodeReferences(value)
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) =>
      codePoint(parseInt(hex, 16))
    )
    .replace(/\\([^\r\n0-9a-fA-F])/g, '$1');
}

/**
 * The value as a URL parser would see it: references decoded, then the
 * characters a parser strips before reading the scheme — whitespace, C0
 * controls and DEL — removed.
 *
 * Stripping them everywhere rather than only at the edges is deliberate:
 * `java\tscript:` is `javascript:` to a browser and to several mail clients.
 */
function urlView(value: string): string {
  return (
    decodeReferences(value)
      // eslint-disable-next-line no-control-regex -- matching them is the point
      .replace(/[\s\u0000-\u001f\u007f]/g, '')
      .toLowerCase()
  );
}

function schemeOf(value: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*:)/.exec(urlView(value));
  return match?.[1];
}

/**
 * Whether a client would fetch this over the network.
 *
 * A scheme of `http:` or `https:`, or no scheme and a network-path start. The
 * WHATWG parser treats `\` as `/` under the special schemes a mail client
 * renders with, so `\\tracker.example/p.gif` and `/\tracker.example/p.gif` are
 * `//tracker.example/p.gif` — the same protocol-relative fetch as two slashes.
 */
function isRemote(value: string): boolean {
  const scheme = schemeOf(value);
  return (
    scheme === 'http:' ||
    scheme === 'https:' ||
    /^[\\/]{2}/.test(urlView(value))
  );
}

/**
 * Whether an attribute value points anywhere a client would fetch from.
 *
 * `srcset` holds a candidate list — `a.gif 1x, b.gif 2x` — and one remote
 * candidate is one beacon, so every candidate counts. The descriptor is dropped
 * before the check because `https://t.example/p.gif 2x` is not a URL and would
 * otherwise read as a relative one.
 */
function hasRemoteCandidate(value: string): boolean {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .some((url) => url !== '' && isRemote(url));
}

/** The first attribute of `element` that would make a client fetch remotely. */
function remoteSubresourceAttribute(element: string): string | undefined {
  SUBRESOURCE_URL_ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SUBRESOURCE_URL_ATTRIBUTE.exec(element)) !== null) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (hasRemoteCandidate(value)) return match[1]?.toLowerCase();
  }
  return undefined;
}

/** How much of a caller-chosen scheme is named in the removal list. */
const MAX_SCHEME_SHOWN = 24;

function abbreviate(scheme: string): string {
  return scheme.length > MAX_SCHEME_SHOWN
    ? `${scheme.slice(0, MAX_SCHEME_SHOWN)}…`
    : scheme;
}

export interface SanitizedHtml {
  html: string;
  /** What was taken out, so the sender can be told rather than surprised. */
  removed: string[];
}

/**
 * Cleans an HTML body before it is sent.
 *
 * This is the one place in the server where an outgoing message is modified,
 * and it needs justifying: everywhere else the rule is "send exactly what the
 * human approved". The exception is here because the HTML part is written by a
 * model, and the three things removed are things a person approving a message
 * cannot see in it — a script that runs on open, a handler on an element, a
 * pixel that reports back. The confirmation dialog shows a subject and a
 * recipient list; it cannot show that the pretty invoice contains a beacon.
 *
 * So: removals are conservative, and every one of them is reported in
 * {@link SanitizedHtml.removed} and shown by `preview_mail`. Nothing is
 * silently rewritten.
 */
export function sanitizeHtml(input: string): SanitizedHtml {
  if (input.length > MAX_HTML_CHARS) {
    throw new ToolInputError(
      `smtp-mcp: the HTML body is ${input.length} characters, over the limit ` +
        `of ${MAX_HTML_CHARS}. Shorten it rather than letting it be truncated.`
    );
  }

  const removed = new Set<string>();
  let html = input;

  html = html.replace(DANGEROUS_BLOCK, (match) => {
    removed.add(
      `<${/^<([a-z]+)/i.exec(match)?.[1]?.toLowerCase() ?? '?'}> element`
    );
    return '';
  });
  html = html.replace(DANGEROUS_VOID, (match) => {
    removed.add(
      `<${/^<\/?([a-z]+)/i.exec(match)?.[1]?.toLowerCase() ?? '?'}> tag`
    );
    return '';
  });

  html = html.replace(REMOTE_SUBRESOURCE, (match, tag: string) => {
    if (remoteSubresourceAttribute(match) === undefined) return match;
    removed.add(`remotely loaded <${tag.toLowerCase()}> (tracking risk)`);
    return '';
  });

  // The same check again, attribute-shaped rather than tag-shaped, and both are
  // needed. This one reaches `background` on a `<body>` or a `<table>`, which
  // are not fetch-on-open elements and must not be deleted whole; and because it
  // never has to match an enclosing tag, it is also the net under the pass above
  // — a beacon in an element whose markup the tag pattern cannot parse still
  // loses its URL here.
  html = html.replace(
    SUBRESOURCE_URL_ATTRIBUTE,
    (match, attribute: string, ...groups) => {
      const value = (groups[0] ?? groups[1] ?? groups[2] ?? '') as string;
      if (!hasRemoteCandidate(value)) return match;
      removed.add(`remote ${attribute.toLowerCase()} URL (tracking risk)`);
      return '';
    }
  );

  html = html.replace(EVENT_HANDLER, (match) => {
    removed.add(
      `${/^\s*on([a-z]+)/i.exec(match)?.[1]?.toLowerCase() ?? 'event'} handler`
    );
    return '';
  });

  html = html.replace(URL_ATTRIBUTE, (match, attribute: string, ...groups) => {
    const value = (groups[0] ?? groups[1] ?? groups[2] ?? '') as string;
    const scheme = schemeOf(value);
    // No scheme at all is a relative URL, which is meaningless in mail and
    // harmless. A scheme that is not on the list is the interesting case.
    if (scheme === undefined || SAFE_SCHEMES.includes(scheme)) return match;
    // The scheme is caller-chosen and, unlike everything else in this list,
    // not bounded by a fixed vocabulary — a 60 kB "scheme" is a legal match.
    // This list is read out in the confirmation dialog, so it is cut here.
    removed.add(`${abbreviate(scheme)} URL in ${attribute.toLowerCase()}`);
    return '';
  });

  // The whole inline style, decoded as a CSS parser would decode it. `u\72l(`
  // is `url(` after that, and the global pass below would never see it.
  html = html.replace(STYLE_ATTRIBUTE, (match, ...groups) => {
    const value = (groups[0] ?? groups[1] ?? groups[2] ?? '') as string;
    if (!CSS_FETCH.test(decodeCssEscapes(value))) return match;
    removed.add('url() in a style attribute');
    return '';
  });

  html = html.replace(CSS_URL, () => {
    removed.add('url() in a style attribute');
    return 'none';
  });

  const survivor = FORBIDDEN_AFTER_SANITIZING.exec(html);
  if (survivor !== null) {
    throw new ToolInputError(
      `smtp-mcp: the HTML body still contains a <${survivor[1]?.toLowerCase() ?? '?'}> ` +
        'tag after sanitising, so it is refused rather than sent. This is what ' +
        'happens when markup cannot be cleaned with confidence — the usual ' +
        'cause is a "<" inside an attribute value. Remove the element and ' +
        'send again.'
    );
  }

  return { html, removed: [...removed] };
}

/**
 * Derives a plain-text alternative from an HTML body.
 *
 * Every HTML mail gets one. A message with no text part is treated as spam by a
 * fair number of filters, and it is unreadable in any client that refuses HTML
 * — which is the setting a security-minded recipient is most likely to be
 * running.
 */
export function htmlToText(html: string): string {
  return (
    html
      .slice(0, MAX_HTML_CHARS)
      .replace(new RegExp(`<!--[\\s\\S]{0,${MAX_BLOCK_CHARS}}?-->`, 'g'), ' ')
      // Same attribute sub-pattern as the removal passes, for the same reason:
      // a `<` inside an attribute value must not end the tag, or the contents
      // of a `<script a="<">` land in the plain-text part a recipient reads.
      .replace(
        new RegExp(
          `<(script|style|head|title|noscript|template)\\b${ATTRS}>[\\s\\S]{0,${MAX_BLOCK_CHARS}}?<\\/\\1>`,
          'gi'
        ),
        ' '
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      // `[^<>]` rather than `[^>]` for the same reason as the patterns above: a
      // run of `<` with no `>` would otherwise be scanned from every position.
      .replace(/<[^<>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      // Stripping `<p>` leaves the space it was replaced with at the start of the
      // line it opened, so every paragraph of the generated plain-text part would
      // begin with a stray space. Cosmetic in a preview, sloppy in a message that
      // a recipient actually reads.
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
