import { describe, expect, it } from 'vitest';

import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  INFO_TOOLS,
  SEND_TOOLS,
} from '../src/tools/catalogue.js';

import { call, connect, sendArgs, toolNames } from './harness.js';
import { expectPortableToolSchemas } from 'mcp-integration-harness';

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

  it('declares an output schema on every tool', async () => {
    // The same argument as the annotations below, one field along. A tool that
    // says nothing about its result forces a client to parse prose to find out
    // what it got, and the SDK sends no `structuredContent` at all for a tool
    // that declared no schema.
    const harness = await connect({ config: { allowSend: true } });
    const { tools } = await harness.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // An object root, not merely a schema. SEP-2106 allows an array or a
      // scalar, but a 2025-era client is served that same tool with the schema
      // rewritten to `{result: …}` — so it would answer in two different
      // shapes depending on who asked.
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
    await harness.close();
  });

  it('advertises schemas every client can read', async () => {
    // Legal JSON Schema is not enough. `{}` in a schema position — what zod
    // writes for `looseObject`, `catchall` and `z.unknown()` — and `type` as an
    // array are both refused, or silently dropped, by some clients. Neither is
    // a contract: each has an equivalent spelling that says the same thing, so
    // there is nothing here to excuse.
    const harness = await connect({ config: { allowSend: true } });
    const { tools } = await harness.client.listTools();
    expectPortableToolSchemas(tools);
    await harness.close();
  });

  it('marks the one tool that reports text it did not write', async () => {
    // preview_mail returns a quoted original, and anyone in the world can send
    // mail. Everything else here is this server's own configuration or the
    // outcome of its own send, so the marker would be a false claim about who
    // wrote it.
    const harness = await connect({ config: { allowSend: true } });
    const { tools } = await harness.client.listTools();
    const marked = tools
      .filter((tool) => {
        const properties = tool.outputSchema?.properties as
          Record<string, unknown> | undefined;
        return properties?.untrusted !== undefined;
      })
      .map((tool) => tool.name);
    expect(marked).toEqual(['preview_mail']);
    await harness.close();
  });

  it('declares all four annotation hints on every tool', async () => {
    // Not a style rule. Two of the four default to a *stronger* claim than
    // silence suggests: the specification gives destructiveHint and
    // openWorldHint a default of true, so a tool that omits them announces
    // itself as destructive and open-world. This repository stated the first
    // two everywhere and left the other two to chance.
    const harness = await connect({ config: { allowSend: true } });
    const { tools } = await harness.client.listTools();
    const hints = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const;
    for (const tool of tools) {
      for (const hint of hints) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          'boolean'
        );
      }
    }
    await harness.close();
  });

  it('says a sent message cannot be sent again for free', async () => {
    // The one annotation on this server that is an approximation rather than
    // a fact. Sending destroys nothing; the message is simply gone, into
    // somebody else's inbox. destructiveHint is the closest the vocabulary
    // comes, and idempotentHint: false is the exact part — every call sends
    // another copy, which is why the confirmation is bound to the content.
    const harness = await connect({ config: { allowSend: true } });
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of ['send_mail', 'reply_mail', 'forward_mail']) {
      expect(byName.get(name)?.destructiveHint, name).toBe(true);
      expect(byName.get(name)?.idempotentHint, name).toBe(false);
    }
    // The four that cannot put anything on the wire say the opposite.
    for (const name of ['preview_mail', 'validate_recipients']) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.destructiveHint, name).toBe(false);
    }
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
