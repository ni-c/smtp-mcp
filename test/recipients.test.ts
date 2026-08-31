import { describe, expect, it } from 'vitest';

import {
  describeAllowlist,
  domainOf,
  isAllowed,
  parseAllowlist,
  refusedRecipients,
} from '../src/recipients.js';

describe('parseAllowlist', () => {
  it('treats unset and empty as no rules at all', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });

  it('reads domains, addresses and the wildcard', () => {
    expect(parseAllowlist('@example.net')).toEqual([
      { kind: 'domain', domain: 'example.net' },
    ]);
    expect(parseAllowlist('anna@example.net')).toEqual([
      { kind: 'address', address: 'anna@example.net' },
    ]);
    expect(parseAllowlist('*')).toEqual([{ kind: 'any' }]);
  });

  it('lower-cases and tolerates spacing and empty entries', () => {
    expect(parseAllowlist(' @Example.NET , , Anna@Example.net ,')).toEqual([
      { kind: 'domain', domain: 'example.net' },
      { kind: 'address', address: 'anna@example.net' },
    ]);
  });

  it('refuses the wildcard combined with anything else', () => {
    // Otherwise deleting the real entries later reads as tightening the list,
    // when "*" had already made them meaningless.
    expect(() => parseAllowlist('*,@example.net')).toThrow(
      /cannot be combined/
    );
  });

  it('refuses a bare word, naming both forms it accepts', () => {
    expect(() => parseAllowlist('example.net')).toThrow(
      /neither an address nor a domain/
    );
  });

  it('refuses a malformed domain or address rather than matching nothing', () => {
    expect(() => parseAllowlist('@example')).toThrow(/not a valid domain/);
    expect(() => parseAllowlist('@exa mple.net')).toThrow(/not a valid domain/);
    expect(() => parseAllowlist('anna@@example.net')).toThrow(
      /not a valid email address/
    );
  });
});

describe('domainOf', () => {
  it('lower-cases the domain of a well-formed address', () => {
    expect(domainOf('Anna@Example.NET')).toBe('example.net');
  });

  it('yields no domain for anything that is not exactly one @', () => {
    // Implementations disagree about which half of a two-@ address is the
    // domain, so there is no reading of it that can safely be allowlisted.
    expect(domainOf('a@evil.example@corp.example')).toBe('');
    expect(domainOf('not-an-address')).toBe('');
    expect(domainOf('')).toBe('');
  });
});

describe('isAllowed', () => {
  const rules = parseAllowlist('@example.net,partner@example.org');

  it('allows an address at an allowlisted domain, case-insensitively', () => {
    expect(isAllowed('anna@example.net', rules)).toBe(true);
    expect(isAllowed('ANNA@EXAMPLE.NET', rules)).toBe(true);
  });

  it('allows an exactly allowlisted address', () => {
    expect(isAllowed('partner@example.org', rules)).toBe(true);
  });

  it('refuses another address at a partially allowlisted domain', () => {
    expect(isAllowed('someone-else@example.org', rules)).toBe(false);
  });

  it('does not extend a domain rule to its subdomains', () => {
    // One allowlisted domain must not become whatever anyone can register
    // underneath it. An operator who wants the subdomain names it.
    expect(isAllowed('anna@mail.example.net', rules)).toBe(false);
  });

  it('does not match a domain that merely ends with an allowlisted one', () => {
    expect(isAllowed('anna@notexample.net', rules)).toBe(false);
    expect(isAllowed('anna@example.net.evil.com', rules)).toBe(false);
  });

  it('refuses a homoglyph domain instead of folding it onto the real one', () => {
    // Cyrillic U+0430 in place of the "a" of example.net, written as an escape
    // so it is visible in review. Normalising before comparison would be the
    // bug: it could turn an address that is not on the list into one that is.
    expect(isAllowed('anna@ex\u0430mple.net', rules)).toBe(false);
  });

  it('refuses an address with a second @, whichever half looks allowlisted', () => {
    // The classic allowlist bypass, closed in both directions: neither the
    // domain that appears first nor the one that appears last can satisfy a
    // rule, because a malformed address has no domain at all here.
    expect(isAllowed('anna@evil.example@example.net', rules)).toBe(false);
    expect(isAllowed('anna@example.net@evil.example', rules)).toBe(false);
  });

  it('allows everything under the wildcard', () => {
    expect(isAllowed('anyone@anywhere.example', parseAllowlist('*'))).toBe(
      true
    );
  });

  it('allows nothing when no rule was configured', () => {
    expect(isAllowed('anna@example.net', [])).toBe(false);
  });
});

describe('refusedRecipients', () => {
  it('returns only the refused ones, in the order given', () => {
    const rules = parseAllowlist('@example.net');
    expect(
      refusedRecipients(
        ['a@example.net', 'b@evil.example', 'c@example.net', 'd@evil.example'],
        rules
      )
    ).toEqual(['b@evil.example', 'd@evil.example']);
  });
});

describe('describeAllowlist', () => {
  it('says so when nothing is configured', () => {
    expect(describeAllowlist([])).toMatch(/not configured/);
  });

  it('collapses to "any recipient" under the wildcard', () => {
    expect(describeAllowlist(parseAllowlist('*'))).toBe('any recipient');
  });

  it('lists domains and addresses', () => {
    expect(
      describeAllowlist(parseAllowlist('@example.net,a@example.org'))
    ).toBe('@example.net, a@example.org');
  });
});
