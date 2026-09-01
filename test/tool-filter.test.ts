/**
 * What this repository still has to prove about its tool filter.
 *
 * The filter lives in `mcp-tool-allowlist` and is tested there: pattern syntax,
 * the preset, how a rejected entry is quoted back, the shape of every message.
 * Repeating that here would test the dependency.
 *
 * What only this repository can assert is the wiring — that the catalogue names
 * exactly the tools the server registers, that the send gate is the thing the
 * `gate` parameter is wired to, that the messages name *these* variables, and
 * that a filtered tool is really gone rather than merely hidden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildToolFilter, ToolFilterError } from 'mcp-tool-allowlist';

import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  INFO_TOOLS,
} from '../src/tools/catalogue.js';

import { call, connect, toolNames } from './harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * This server's wiring of `buildToolFilter`, so the cases below stay about the
 * catalogue and the send gate rather than about the option object. It has to
 * match src/server.ts — that it does is what the end-to-end cases prove.
 */
function build(
  allowTools: string | undefined,
  denyTools: string | undefined = undefined,
  allowSend = true
) {
  return buildToolFilter({
    allowTools,
    denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
      ungated: INFO_TOOLS,
    },
    names: {
      allow: 'SMTP_ALLOW_TOOLS',
      deny: 'SMTP_DENY_TOOLS',
      server: 'smtp-mcp',
    },
    gate: {
      closed: !allowSend,
      variable: 'SMTP_ALLOW_SEND',
      noun: 'the send gate',
    },
  });
}

function filter(
  allowTools: string | undefined,
  denyTools: string | undefined = undefined,
  allowSend = true
): Set<string> {
  return new Set(build(allowTools, denyTools, allowSend).selected);
}

describe('buildToolFilter', () => {
  it('is inactive when neither variable is set', () => {
    const built = build(undefined);
    expect(built.active).toBe(false);
  });

  it('selects exactly the named tools', () => {
    expect(filter('get_server_info,send_mail')).toEqual(
      new Set(['get_server_info', 'send_mail'])
    );
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
    // SDK v2 answers a call to an unknown tool with a JSON-RPC error rather
    // than a result carrying isError; the tool is still removed, not disabled.
    await expect(call(harness.client, 'forward_mail', {})).rejects.toThrow(
      /not found/i
    );
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
