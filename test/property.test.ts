import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeMessageId } from '../src/compose.js';
import {
  domainOf,
  isAllowed,
  parseAllowlist,
  refusedRecipients,
} from '../src/recipients.js';

/**
 * Properties of the recipient allowlist.
 *
 * This server sends. The allowlist is not one control among several here, it is
 * the control — the thing standing between a model that has been talked into
 * writing a mail and that mail reaching a stranger. Its comments already record
 * three decisions that are only decisions because the alternative is a hole:
 * a domain rule does not cover subdomains, a malformed address resolves to no
 * domain at all, and comparison is deliberately not Unicode-normalised.
 *
 * All three are statements about every address, which is what a property is for
 * and what a list of examples cannot be.
 */

const RUNS = { numRuns: 500 };

const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
const domain = fc
  .tuple(label, fc.constantFrom('net', 'com', 'org', 'de'))
  .map(([name, tld]) => `${name}.${tld}`);
const local = fc.stringMatching(/^[a-z][a-z0-9._-]{0,12}$/);

describe('a domain rule covers that domain and nothing under it', () => {
  /**
   * The decision the comment argues for: subdomain matching is the kind of
   * convenience that turns one allowlisted domain into whatever anyone can
   * register underneath it.
   */
  it('never allows a subdomain of an allowed domain', () => {
    fc.assert(
      fc.property(local, label, domain, (user, sub, allowed) => {
        const rules = parseAllowlist(`@${allowed}`);
        expect(isAllowed(`${user}@${allowed}`, rules)).toBe(true);
        expect(isAllowed(`${user}@${sub}.${allowed}`, rules)).toBe(false);
      }),
      RUNS
    );
  });

  /** Nor a domain that merely ends with the allowed one as a suffix. */
  it('never allows a domain that only looks like a suffix match', () => {
    fc.assert(
      fc.property(local, label, domain, (user, prefix, allowed) => {
        const rules = parseAllowlist(`@${allowed}`);
        expect(isAllowed(`${user}@${prefix}${allowed}`, rules)).toBe(false);
      }),
      RUNS
    );
  });

  it('an exact-address rule allows only that address', () => {
    fc.assert(
      fc.property(local, local, domain, (user, other, host) => {
        fc.pre(user !== other);
        const rules = parseAllowlist(`${user}@${host}`);
        expect(isAllowed(`${user}@${host}`, rules)).toBe(true);
        expect(isAllowed(`${other}@${host}`, rules)).toBe(false);
      }),
      RUNS
    );
  });

  it('case is folded, so an allowlist is not defeated by shouting', () => {
    fc.assert(
      fc.property(local, domain, (user, host) => {
        const rules = parseAllowlist(`@${host}`);
        expect(isAllowed(`${user}@${host}`.toUpperCase(), rules)).toBe(true);
      }),
      RUNS
    );
  });
});

describe('a malformed address resolves to no domain at all', () => {
  /**
   * `domainOf` returns the empty string for anything that is not exactly one
   * `@`, which makes every domain rule miss — and the exact-address rules
   * cannot match either, because `parseAllowlist` only admits entries with one
   * `@`. The comment calls this the second lock on the same door, and it is the
   * one that holds if the schema is ever loosened.
   */
  it('an address without exactly one @ is allowed by no rule', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40, unit: 'binary' }),
        domain,
        (address, host) => {
          fc.pre(address.split('@').length !== 2);
          expect(domainOf(address)).toBe('');
          expect(isAllowed(address, parseAllowlist(`@${host}`))).toBe(false);
          expect(isAllowed(address, parseAllowlist(`someone@${host}`))).toBe(
            false
          );
        }
      ),
      RUNS
    );
  });

  /**
   * Comparison is deliberately not Unicode-normalised. NFKC folding is right
   * for text a human reads and wrong here: it maps lookalike code points onto
   * ASCII ones and could turn an address that is not on the list into one that
   * matches it. Comparing as given means a homoglyph domain simply fails, which
   * is the direction this has to fail in.
   */
  it('a homoglyph domain does not match its ASCII lookalike', () => {
    fc.assert(
      fc.property(
        local,
        fc.constantFrom(
          ['examp1e.net', 'example.net'],
          ['exampⅼe.net', 'example.net'],
          ['ｅxample.net', 'example.net'],
          ['examрle.net', 'example.net']
        ),
        (user, [lookalike, real]) => {
          const rules = parseAllowlist(`@${real}`);
          expect(isAllowed(`${user}@${lookalike}`, rules)).toBe(false);
        }
      ),
      RUNS
    );
  });
});

describe('the allowlist refuses what it cannot express', () => {
  /**
   * An entry that silently matched nothing would narrow the allowlist without
   * saying so, and the symptom — "the server refuses to mail my colleague" —
   * points at the wrong place.
   */
  it('anything that is not one of the three shapes throws', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (entry) => {
        const trimmed = entry.trim();
        fc.pre(trimmed !== '' && trimmed !== '*');
        fc.pre(trimmed.split('@').length !== 2);
        fc.pre(!trimmed.includes(','));
        expect(() => parseAllowlist(trimmed)).toThrow();
      }),
      RUNS
    );
  });

  it('an unset or empty allowlist allows nobody', () => {
    fc.assert(
      fc.property(local, domain, (user, host) => {
        for (const raw of [undefined, '', '   ']) {
          expect(isAllowed(`${user}@${host}`, parseAllowlist(raw))).toBe(false);
        }
      }),
      RUNS
    );
  });

  it('a star allows everyone, which is the only rule that should', () => {
    fc.assert(
      fc.property(local, domain, (user, host) => {
        expect(isAllowed(`${user}@${host}`, parseAllowlist('*'))).toBe(true);
      }),
      RUNS
    );
  });
});

describe('refusals are reported completely and in order', () => {
  /**
   * The caller is told which addresses were refused so it can say so. A list
   * that dropped one would let a mail go out to a recipient nobody named, and a
   * reordered one would attach the wrong explanation to the wrong address.
   */
  it('names exactly the addresses no rule allows, in the order given', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(local, domain), { maxLength: 12 }),
        domain,
        (pairs, allowed) => {
          const addresses = pairs.map(([user, host]) => `${user}@${host}`);
          const rules = parseAllowlist(`@${allowed}`);
          const refused = refusedRecipients(addresses, rules);
          expect(refused).toEqual(
            addresses.filter((address) => !isAllowed(address, rules))
          );
          for (const address of refused) {
            expect(isAllowed(address, rules)).toBe(false);
          }
        }
      ),
      RUNS
    );
  });
});

describe('a Message-ID is bracketed exactly once', () => {
  it('is idempotent and always bracketed', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9.@-]{1,40}$/), (id) => {
        const once = normalizeMessageId(id);
        expect(once.startsWith('<')).toBe(true);
        expect(once.endsWith('>')).toBe(true);
        expect(normalizeMessageId(once)).toBe(once);
      }),
      RUNS
    );
  });
});
