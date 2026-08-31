import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildToolFilter, ToolFilterError } from '../src/tool-filter.js';
import { ESSENTIAL_TOOLS, INFO_TOOLS } from '../src/tools/catalogue.js';

import { call, connect, textOf, toolNames } from './harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function filter(
  allowTools: string | undefined,
  denyTools: string | undefined = undefined,
  allowSend = true
): Set<string> {
  const built = buildToolFilter({ allowTools, denyTools, allowSend });
  return new Set(built.selected);
}

describe('buildToolFilter', () => {
  it('is inactive when neither variable is set', () => {
    const built = buildToolFilter({
      allowTools: undefined,
      denyTools: undefined,
      allowSend: true,
    });
    expect(built.active).toBe(false);
  });

  it('treats an empty or whitespace-only value as unset', () => {
    // `SMTP_ALLOW_TOOLS=` in a compose file must not mean "allow nothing".
    for (const value of ['', '   ', ',,']) {
      expect(
        buildToolFilter({
          allowTools: value,
          denyTools: undefined,
          allowSend: true,
        }).active
      ).toBe(false);
    }
  });

  it('selects exactly the named tools', () => {
    expect(filter('get_server_info,send_mail')).toEqual(
      new Set(['get_server_info', 'send_mail'])
    );
  });

  it('trims and lower-cases entries', () => {
    expect(filter(' Get_Server_Info , SEND_MAIL ')).toEqual(
      new Set(['get_server_info', 'send_mail'])
    );
  });

  it('expands a trailing-star prefix', () => {
    expect(filter('send_*')).toEqual(new Set(['send_mail']));
  });

  it('resolves the essential preset', () => {
    expect(filter('essential')).toEqual(new Set(ESSENTIAL_TOOLS));
  });

  it('subtracts the deny list from everything otherwise registered', () => {
    const selected = filter(undefined, 'forward_mail');
    expect(selected.has('forward_mail')).toBe(false);
    expect(selected.has('send_mail')).toBe(true);
  });

  it('applies deny after allow', () => {
    expect(filter('essential', 'send_mail').has('send_mail')).toBe(false);
  });

  it('refuses an entry that matches no tool at all', () => {
    // An ignored typo leaves a tool missing from tools/list with nothing
    // pointing at the cause.
    expect(() => filter('send_email')).toThrow(ToolFilterError);
    expect(() => filter('send_email')).toThrow(/no tool matches/);
    expect(() => filter(undefined, 'delete_all')).toThrow(/no tool matches/);
  });

  it('refuses a malformed pattern', () => {
    expect(() => filter('*_mail')).toThrow(/prefix/);
    expect(() => filter('send_*_x')).toThrow(/prefix/);
  });

  it('names the send gate when an exact sending tool is asked for with it off', () => {
    expect(() => filter('send_mail', undefined, false)).toThrow(
      /SMTP_ALLOW_SEND/
    );
  });

  it('only warns when a pattern matches nothing but sending tools', () => {
    // A pattern is a template, not a claim about one tool.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      filter('send_*,get_server_info', undefined, false)
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/contributes nothing/)
    );
  });

  it('drops preset members the send gate suppresses, without complaining', () => {
    // Preset members are not names the operator typed.
    const selected = filter('essential', undefined, false);
    expect(selected).toEqual(
      new Set(ESSENTIAL_TOOLS.filter((t) => INFO_TOOLS.includes(t as never)))
    );
  });

  it('refuses to start with an empty tool list, saying which cause it was', () => {
    expect(() => filter('get_server_info', 'get_server_info')).toThrow(
      /empty tool list/
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => filter('send_*', undefined, false)).toThrow(
      /SMTP_ALLOW_SEND.*empty tool list/s
    );
    warn.mockRestore();
  });
});

describe('installToolFilter, end to end', () => {
  it('removes a filtered tool rather than disabling it', async () => {
    const harness = await connect({
      config: { allowSend: true, denyTools: 'forward_mail' },
    });
    expect(await toolNames(harness.client)).not.toContain('forward_mail');
    // "not found", exactly like a tool the send gate never registered — not
    // "disabled", which would be advertising a refusal.
    const result = await call(harness.client, 'forward_mail', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not found/i);
    await harness.close();
  });

  it('still answers tools/list when almost everything is filtered out', async () => {
    // The SDK installs its tools/list handler from inside the registration
    // path, which is why the tools are registered and then removed.
    const harness = await connect({
      config: { allowSend: true, allowTools: 'get_server_info' },
    });
    expect(await toolNames(harness.client)).toEqual(['get_server_info']);
    await harness.close();
  });
});
