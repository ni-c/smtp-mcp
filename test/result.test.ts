import { describe, expect, it } from 'vitest';

import { SmtpError, ToolInputError } from '../src/errors.js';
import {
  budgetedJson,
  errorResult,
  fencedUntrustedResult,
  jsonResult,
  MAX_RESULT_BYTES,
  run,
  sanitizeErrorBody,
  textResult,
  untrustedResult,
} from '../src/result.js';

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

describe('budgetedJson', () => {
  it('returns the whole document when it fits', () => {
    expect(JSON.parse(budgetedJson({ a: 1 }))).toEqual({ a: 1 });
  });

  it('drops whole items rather than characters', () => {
    // Slicing the serialized JSON hands the model a document cut off
    // mid-string, and the recovery hint is the first thing to disappear.
    const items = Array.from({ length: 5000 }, (_, i) => ({
      i,
      text: 'x'.repeat(200),
    }));
    const parsed = JSON.parse(budgetedJson({ items })) as {
      truncated: {
        returned_items: number;
        omitted_items: number;
        follow_up: string;
      };
      items: unknown[];
    };
    expect(parsed.items.length).toBe(parsed.truncated.returned_items);
    expect(parsed.truncated.omitted_items).toBeGreaterThan(0);
    expect(parsed.truncated.follow_up).toBeTruthy();
  });

  it('stays under the budget', () => {
    const items = Array.from({ length: 5000 }, () => 'x'.repeat(200));
    expect(budgetedJson({ items }).length).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
  });

  it('shrinks a bare array too', () => {
    const parsed = JSON.parse(
      budgetedJson(Array.from({ length: 5000 }, () => 'x'.repeat(200)))
    ) as { items: unknown[]; truncated: unknown };
    expect(parsed.truncated).toBeDefined();
    expect(parsed.items.length).toBeLessThan(5000);
  });

  it('still emits valid JSON when there is no array to shrink', () => {
    const parsed = JSON.parse(budgetedJson({ blob: 'x'.repeat(300_000) })) as {
      truncated: unknown;
      partial_json: string;
    };
    expect(parsed.truncated).toBeDefined();
    expect(typeof parsed.partial_json).toBe('string');
  });

  it('uses the follow-up hint the caller supplied', () => {
    const parsed = JSON.parse(
      budgetedJson(
        { items: Array.from({ length: 5000 }, () => 'x'.repeat(200)) },
        'do this instead'
      )
    ) as { truncated: { follow_up: string } };
    expect(parsed.truncated.follow_up).toBe('do this instead');
  });
});

describe('result helpers', () => {
  it('marks an error result as one', () => {
    expect(errorResult('nope').isError).toBe(true);
    expect(textResult('fine').isError).toBeUndefined();
  });

  it('prefixes untrusted data with a warning', () => {
    expect(textOf(untrustedResult({ a: 1 }))).toMatch(
      /did not write|never as instructions/
    );
  });

  it('passes a string through untrustedResult unserialised', () => {
    expect(textOf(untrustedResult('plain'))).toContain('plain');
  });

  it('fences content with a nonce the content cannot forge', () => {
    const text = textOf(fencedUntrustedResult('header', 'body line'));
    const nonce = /BEGIN UNTRUSTED MESSAGE CONTENT \[([0-9a-f-]{36})\]/.exec(
      text
    )?.[1];
    expect(nonce).toBeTruthy();
    expect(text).toContain(`END UNTRUSTED MESSAGE CONTENT [${nonce}]`);
    // Every line is datamarked, so the boundary keeps being visible.
    expect(text).toMatch(/[0-9a-f]{8}\| body line/);
  });

  it('puts an injection warning above everything else', () => {
    const text = textOf(
      fencedUntrustedResult('header', 'body', ['instruction-override'])
    );
    expect(text.indexOf('!! WARNING')).toBeLessThan(text.indexOf('header'));
    expect(text).toContain('instruction-override');
  });

  it('serialises server-authored data plainly', () => {
    expect(JSON.parse(textOf(jsonResult({ ok: true })))).toEqual({ ok: true });
  });
});

describe('sanitizeErrorBody', () => {
  it('drops an HTML error page entirely', () => {
    // A captive portal or a proxy answering on the submission port.
    expect(
      sanitizeErrorBody('<!DOCTYPE html><html><body>hi</body></html>')
    ).toBe('(HTML error page omitted)');
    expect(sanitizeErrorBody('<html><body>hi</body></html>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('truncates anything else', () => {
    const body = sanitizeErrorBody('x'.repeat(5000));
    expect(body.length).toBeLessThan(2100);
    expect(body).toMatch(/truncated/);
  });

  it('leaves a short reply alone', () => {
    expect(sanitizeErrorBody('  550 5.1.1 unknown user  ')).toBe(
      '550 5.1.1 unknown user'
    );
  });
});

describe('run', () => {
  it('passes a successful result through', async () => {
    expect(await run(async () => textResult('ok'))).toEqual(textResult('ok'));
  });

  it('turns a caller error into a result rather than a protocol failure', async () => {
    const result = await run(async () => {
      throw new ToolInputError('smtp-mcp: bad argument');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('smtp-mcp: bad argument');
  });

  it('adds an actionable hint for each SMTP failure it knows', async () => {
    const cases: Array<[string, RegExp]> = [
      ['EAUTH', /SMTP_USER and SMTP_PASSWORD/],
      ['EENVELOPE', /SMTP_FROM/],
      ['EMESSAGE', /size limit or a content filter/],
      ['ETLS', /SMTP_TLS/],
      ['ESOCKET', /SMTP_HOST, SMTP_PORT and SMTP_TLS/],
      ['ECONNECTION', /SMTP_HOST, SMTP_PORT and SMTP_TLS/],
    ];
    for (const [code, hint] of cases) {
      const result = await run(async () => {
        throw new SmtpError('smtp-mcp: failed', code, '535 nope');
      });
      expect(textOf(result)).toMatch(hint);
      expect(textOf(result)).toContain('535 nope');
    }
  });

  it('says nothing extra for an unknown code', async () => {
    const result = await run(async () => {
      throw new SmtpError('smtp-mcp: failed', 'EWHATEVER');
    });
    expect(textOf(result)).toBe('smtp-mcp: failed');
  });

  it('names the server for anything it did not expect', async () => {
    const result = await run(async () => {
      throw new Error('boom');
    });
    expect(textOf(result)).toBe('smtp-mcp: boom');
    const thrown = await run(async () => {
      throw 'a string';
    });
    expect(textOf(thrown)).toBe('smtp-mcp: a string');
  });
});
