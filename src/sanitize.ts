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

/** Elements dropped together with their contents. */
const DANGEROUS_BLOCK = new RegExp(
  `<(script|style|iframe|object|embed|applet|noscript|template|form|svg|math)\\b${ATTRS}>[\\s\\S]{0,${MAX_BLOCK_CHARS}}?<\\/\\1\\s*>`,
  'gi'
);
/** The same elements when they are left unclosed, plus the void ones. */
const DANGEROUS_VOID = new RegExp(
  `<\\/?(script|style|iframe|object|embed|applet|noscript|template|form|svg|math|base|link|meta|frame|frameset)\\b${ATTRS}>`,
  'gi'
);

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
const SUBRESOURCE_URL_ATTRIBUTE =
  /\s(src|srcset|imagesrcset|poster|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))/gi;

/** Attributes that run script when the recipient does anything at all. */
const EVENT_HANDLER = /\son[a-z]{1,20}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>]+)/gi;

/** URL-valued attributes whose scheme has to be checked. */
const URL_ATTRIBUTE =
  /\s(href|src|action|formaction|data|poster|background|cite)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))/gi;

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
const FORBIDDEN_AFTER_SANITIZING =
  /<\s*\/?\s*(script|style|iframe|object|embed|applet|form|svg|math)\b/i;

/** `url(...)` inside a style attribute — another way to fetch a remote asset. */
const CSS_URL = /url\s*\(\s*(['"]?)[^)'"]{0,2000}\1\s*\)/gi;

const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:', 'cid:'];

function schemeOf(value: string): string | undefined {
  // Leading whitespace and control characters are stripped by parsers before
  // the scheme is read, so `java\tscript:` is `javascript:` to a browser and to
  // several mail clients. Strip them here too rather than after the match.
  // eslint-disable-next-line no-control-regex -- matching them is the point
  const trimmed = value.replace(/[\s\u0000-\u001f\u007f]/g, '').toLowerCase();
  const match = /^([a-z][a-z0-9+.-]*:)/.exec(trimmed);
  return match?.[1];
}

function isRemote(value: string): boolean {
  const scheme = schemeOf(value);
  return scheme === 'http:' || scheme === 'https:' || value.startsWith('//');
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
      `${/\son([a-z]+)/i.exec(match)?.[1]?.toLowerCase() ?? 'event'} handler`
    );
    return '';
  });

  html = html.replace(URL_ATTRIBUTE, (match, attribute: string, ...groups) => {
    const value = (groups[0] ?? groups[1] ?? groups[2] ?? '') as string;
    const scheme = schemeOf(value);
    // No scheme at all is a relative URL, which is meaningless in mail and
    // harmless. A scheme that is not on the list is the interesting case.
    if (scheme === undefined || SAFE_SCHEMES.includes(scheme)) return match;
    removed.add(`${scheme} URL in ${attribute.toLowerCase()}`);
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
