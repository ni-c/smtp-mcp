import { ToolInputError } from './errors.js';

/**
 * Upper bound on an HTML body.
 *
 * Note that this **refuses** rather than truncating. Everywhere else in this
 * server an over-long string is cut short, because the reader is a model and
 * half the text is better than none. Here the reader is a recipient, and half a
 * message is worse than an error: it would arrive looking deliberate.
 */
const MAX_HTML_CHARS = 512_000;
/** Bounds each removal regex so a body full of unclosed tags cannot hang it. */
const MAX_BLOCK_CHARS = 50_000;

/** Elements dropped together with their contents. */
const DANGEROUS_BLOCK = new RegExp(
  `<(script|style|iframe|object|embed|applet|noscript|template|form|svg|math)\\b[\\s\\S]{0,${MAX_BLOCK_CHARS}}?<\\/\\1\\s*>`,
  'gi'
);
/** The same elements when they are left unclosed, plus the void ones. */
const DANGEROUS_VOID =
  /<\/?(script|style|iframe|object|embed|applet|noscript|template|form|svg|math|base|link|meta|frame|frameset)\b[^>]*>/gi;

/**
 * Elements a mail client fetches on its own. Removing them is the difference
 * between a message and a beacon: a 1×1 image tells the sender when, where and
 * how often the recipient opened their mail, and this server should not be the
 * easy way to add one.
 *
 * Links are deliberately left alone — they are click-only, they fetch nothing
 * by themselves, and an HTML mail without links is not worth sending.
 */
const REMOTE_SUBRESOURCE =
  /<(img|image|input|video|audio|source|track|iframe)\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/** Attributes that run script when the recipient does anything at all. */
const EVENT_HANDLER = /\son[a-z]{1,20}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** URL-valued attributes whose scheme has to be checked. */
const URL_ATTRIBUTE =
  /\s(href|src|action|formaction|data|poster|background|cite)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

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

  html = html.replace(REMOTE_SUBRESOURCE, (match, tag: string, ...groups) => {
    const value = (groups[0] ?? groups[1] ?? groups[2] ?? '') as string;
    if (!isRemote(value)) return match;
    removed.add(`remotely loaded <${tag.toLowerCase()}> (tracking risk)`);
    return '';
  });

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
      .replace(
        new RegExp(
          `<(script|style|head|title|noscript|template)\\b[\\s\\S]{0,${MAX_BLOCK_CHARS}}?<\\/\\1>`,
          'gi'
        ),
        ' '
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
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
