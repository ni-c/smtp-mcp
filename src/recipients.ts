/**
 * Who this server is allowed to write to.
 *
 * This is the boundary that survives everything else failing. The confirmation
 * dialog assumes a human is present and reading; the rate limit assumes an
 * attacker is in a hurry. The allowlist assumes nothing: an address that is not
 * on it is refused before a connection is opened, whatever the model was told
 * and whoever it believes told it. On a server whose whole purpose is an
 * outbound channel, that is the control that turns "it can send mail" into "it
 * can send mail to these people".
 */

/** One entry of `SMTP_ALLOWED_RECIPIENTS`. */
export type RecipientRule =
  | { kind: 'any' }
  | { kind: 'domain'; domain: string }
  | { kind: 'address'; address: string };

/**
 * The domain of an address that has exactly one `@`, and `''` for anything else.
 *
 * The `!== 1` case is the important one. `a@evil.example@corp.example` is not a
 * valid address, and implementations disagree about which half is the domain —
 * so an allowlist that picked either one would be checking a domain that the
 * delivery path might not use. There is no safe way to guess, and guessing
 * wrong means the check passes and the mail goes somewhere else.
 *
 * Returning `''` makes every domain rule miss, and the exact-address rules
 * cannot match either because `parseAllowlist` only admits entries with one
 * `@`. So a malformed address is refused rather than resolved. `addressParam`
 * already rejects these at the schema; this is the second lock on the same
 * door, and it is the one that holds if the schema is ever loosened.
 */
export function domainOf(address: string): string {
  const parts = address.split('@');
  if (parts.length !== 2) return '';
  return (parts[1] ?? '').toLowerCase();
}

function normalize(value: string): string {
  // Lowercased, and deliberately NOT Unicode-normalised. NFKC folding is right
  // for text a human reads and wrong here: it would map lookalike codepoints
  // onto ASCII ones and could turn an address that is not on the list into one
  // that matches it. Comparing the bytes as given means a homoglyph domain
  // simply fails to match, which is the direction this has to fail in.
  return value.trim().toLowerCase();
}

/**
 * Parses `SMTP_ALLOWED_RECIPIENTS`.
 *
 * Accepts `*` (any recipient), `@example.net` (any address at exactly that
 * domain) and `person@example.net` (that one address). Anything else throws:
 * an entry that silently matches nothing would narrow the allowlist without
 * saying so, and the symptom — "the server refuses to mail my colleague" —
 * points at the wrong place.
 */
export function parseAllowlist(raw: string | undefined): RecipientRule[] {
  if (raw === undefined || raw.trim() === '') return [];

  const entries = raw
    .split(',')
    .map((entry) => normalize(entry))
    .filter((entry) => entry !== '');

  if (entries.includes('*')) {
    // "*" together with real entries reads as "these, plus a wildcard I forgot
    // to remove", and the person deleting the real entries later believes they
    // are tightening the list. It is not: "*" already allowed everything.
    if (entries.length > 1) {
      throw new Error(
        'SMTP_ALLOWED_RECIPIENTS: "*" allows every recipient, so it cannot be ' +
          'combined with other entries. Use "*" alone, or list the addresses ' +
          'and domains you mean.'
      );
    }
    return [{ kind: 'any' }];
  }

  return entries.map((entry) => {
    if (entry.startsWith('@')) {
      const domain = entry.slice(1);
      if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain)) {
        throw new Error(
          `SMTP_ALLOWED_RECIPIENTS: "${entry}" is not a valid domain entry — ` +
            'write it as "@example.net".'
        );
      }
      return { kind: 'domain', domain };
    }
    if (!entry.includes('@')) {
      throw new Error(
        `SMTP_ALLOWED_RECIPIENTS: "${entry}" is neither an address nor a ` +
          'domain. Write "@example.net" for a whole domain, or ' +
          '"person@example.net" for one address.'
      );
    }
    if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(entry)) {
      throw new Error(
        `SMTP_ALLOWED_RECIPIENTS: "${entry}" is not a valid email address.`
      );
    }
    return { kind: 'address', address: entry };
  });
}

/**
 * Whether `address` may receive mail.
 *
 * A domain rule covers addresses **at** that domain and not below it:
 * `@example.net` does not match `person@mail.example.net`. Subdomain matching
 * is the kind of convenience that turns one allowlisted domain into whatever
 * anyone can register underneath it, and an operator who wants the subdomain
 * can name it.
 */
export function isAllowed(
  address: string,
  rules: readonly RecipientRule[]
): boolean {
  const normalized = normalize(address);
  const domain = domainOf(normalized);
  return rules.some((rule) => {
    if (rule.kind === 'any') return true;
    if (rule.kind === 'domain') return domain === rule.domain;
    return normalized === rule.address;
  });
}

/** The addresses in `addresses` that no rule allows, in the order given. */
export function refusedRecipients(
  addresses: readonly string[],
  rules: readonly RecipientRule[]
): string[] {
  return addresses.filter((address) => !isAllowed(address, rules));
}

/** Short human-readable form of the allowlist, for `get_server_info`. */
export function describeAllowlist(rules: readonly RecipientRule[]): string {
  if (rules.length === 0) return 'not configured (sending is off)';
  const parts: string[] = [];
  for (const rule of rules) {
    // An "any" rule cannot be combined with others (parseAllowlist refuses it),
    // so meeting one here means the whole list is "everything".
    if (rule.kind === 'any') return 'any recipient';
    parts.push(rule.kind === 'domain' ? `@${rule.domain}` : rule.address);
  }
  return parts.join(', ');
}
