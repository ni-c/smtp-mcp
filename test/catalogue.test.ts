import { describe, expect, it } from 'vitest';

import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  INFO_TOOLS,
  SEND_TOOLS,
} from '../src/tools/catalogue.js';

import { call, connect, sendArgs, toolNames } from './harness.js';

/**
 * The catalogue is declared rather than derived, so something has to check it
 * against reality. That is this file — and it is also why no other test file
 * keeps its own copy of the tool names.
 */
describe('the catalogue matches the server', () => {
  it('registers exactly the info tools when sending is off', async () => {
    const harness = await connect({ config: { allowSend: false } });
    expect(await toolNames(harness.client)).toEqual([...INFO_TOOLS].sort());
    await harness.close();
  });

  it('registers exactly the full catalogue when sending is on', async () => {
    const harness = await connect({ config: { allowSend: true } });
    expect(await toolNames(harness.client)).toEqual([...ALL_TOOLS].sort());
    await harness.close();
  });

  it('registers no sending tool until SMTP_ALLOW_SEND is set', async () => {
    // The defining property of this server's default state. Its counterpart
    // imap-mcp asserts that it has no sending tool at all; here the tool exists
    // and the gate is what keeps it out of tools/list.
    const harness = await connect({ config: { allowSend: false } });
    const names = (await toolNames(harness.client)).join(' ');
    expect(names).not.toMatch(/send_mail|reply_mail|forward_mail/);
    await harness.close();
  });

  it('answers a suppressed sending tool with "not found"', async () => {
    const harness = await connect({ config: { allowSend: false } });
    // SDK v2 answers a call to an unknown tool with a JSON-RPC error rather
    // than a result carrying isError; the tool is still absent entirely.
    await expect(call(harness.client, 'send_mail', sendArgs())).rejects.toThrow(
      /not found/i
    );
    await harness.close();
  });
});

describe('the essential preset', () => {
  it('names only tools that exist', () => {
    for (const tool of ESSENTIAL_TOOLS) {
      expect(ALL_TOOLS).toContain(tool);
    }
  });

  it('stays in the five-to-eight range the family uses', () => {
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
  });

  it('leaves out the tool that carries somebody else’s content outward', () => {
    expect(ESSENTIAL_TOOLS).not.toContain('forward_mail');
  });
});

describe('the catalogue itself', () => {
  it('is the concatenation of its two halves, with no overlap', () => {
    expect([...ALL_TOOLS]).toEqual([...INFO_TOOLS, ...SEND_TOOLS]);
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('keeps every name lowercase, which the filter relies on', () => {
    for (const tool of ALL_TOOLS) expect(tool).toBe(tool.toLowerCase());
  });
});
