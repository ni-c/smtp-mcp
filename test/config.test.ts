import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SMTP_HOST: 'smtp.example.net',
    SMTP_USER: 'me@example.net',
    SMTP_PASSWORD: 'secret-password',
    SMTP_FROM: 'Me <me@example.net>',
    ...overrides,
  };
}

/** Turns the `process.exit(1)` paths into something a test can observe. */
function expectExit(): {
  errors: ReturnType<typeof vi.spyOn>;
  exit: ReturnType<typeof vi.spyOn>;
} {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  return { errors, exit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env()).elicitation).toBe(true);
    expect(loadConfig(env({ ELICITATION: '' })).elicitation).toBe(true);
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(loadConfig(env({ ELICITATION: raw })).elicitation, raw).toBe(
        false
      );
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ELICITATION: raw }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.SMTP_PASSWORD).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(env());
    expect(config.smtp.host).toBe('smtp.example.net');
    // STARTTLS on the submission port, because that is what an authenticated
    // client is supposed to use.
    expect(config.smtp.tls).toBe('starttls');
    expect(config.smtp.port).toBe(587);
    expect(config.maxRecipients).toBe(10);
    expect(config.maxSendsPerHour).toBe(20);
    expect(config.attachmentDir).toBeUndefined();
    // The defining default of this server: it cannot send anything until an
    // operator says so.
    expect(config.allowSend).toBe(false);
  });

  it('picks the port from the TLS mode', () => {
    expect(loadConfig(env({ SMTP_TLS: 'implicit' })).smtp.port).toBe(465);
    expect(loadConfig(env({ SMTP_TLS: 'starttls' })).smtp.port).toBe(587);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadConfig(env({ SMTP_TLS: 'none' })).smtp.port).toBe(25);
    errors.mockRestore();
  });

  it('removes the password from the environment', () => {
    const environment = env();
    loadConfig(environment);
    expect(environment.SMTP_PASSWORD).toBeUndefined();
  });

  it('removes the password even when the rest of the config is missing', () => {
    // The early warning path for "no host" is exactly where somebody attaches
    // an inspector to work out why the server will not start, so the password
    // must already be gone by then.
    const environment: NodeJS.ProcessEnv = { SMTP_PASSWORD: 'secret-password' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(environment);
    expect(environment.SMTP_PASSWORD).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  it('starts without credentials and only warns', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({});
    expect(config.smtp.host).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'SMTP_FROM',
    ]);
    expect(errors).toHaveBeenCalled();
  });

  it('parses the sender in both accepted forms', () => {
    expect(
      loadConfig(env({ SMTP_FROM: 'me@example.net' })).smtp.fromAddress
    ).toBe('me@example.net');
    expect(
      loadConfig(env({ SMTP_FROM: 'Me Myself <me@example.net>' })).smtp
        .fromAddress
    ).toBe('me@example.net');
  });

  it('refuses a sender that is not an address', () => {
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_FROM: 'just a name' }))).toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toContain('SMTP_FROM');
  });

  it('refuses to enable sending without an allowlist', () => {
    // Treating an unset allowlist as "anyone" is the accident this prevents: it
    // reads as a missing line rather than as a decision, and the failure it
    // causes is a message already delivered.
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_ALLOW_SEND: 'true' }))).toThrow('exit');
    const said = errors.mock.calls.flat().join(' ');
    expect(said).toContain('SMTP_ALLOWED_RECIPIENTS');
    expect(said).toContain('"*"');
  });

  it('accepts the explicit wildcard as the way to allow everyone', () => {
    const config = loadConfig(
      env({ SMTP_ALLOW_SEND: 'true', SMTP_ALLOWED_RECIPIENTS: '*' })
    );
    expect(config.allowSend).toBe(true);
    expect(config.allowedRecipients).toEqual([{ kind: 'any' }]);
  });

  it('only enables sending for the literal string "true"', () => {
    for (const value of ['TRUE', '1', 'yes', 'on', '']) {
      expect(
        loadConfig(
          env({ SMTP_ALLOW_SEND: value, SMTP_ALLOWED_RECIPIENTS: '*' })
        ).allowSend
      ).toBe(false);
    }
  });

  it('refuses a malformed allowlist rather than matching nothing', () => {
    const { errors } = expectExit();
    expect(() =>
      loadConfig(env({ SMTP_ALLOWED_RECIPIENTS: 'example.net' }))
    ).toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toContain(
      'SMTP_ALLOWED_RECIPIENTS'
    );
  });

  it('refuses a bad port without echoing the value', () => {
    // Config errors end up in logs, and this branch is where a token pasted
    // into the wrong variable arrives.
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_PORT: 'ghp_secrettoken' }))).toThrow(
      'exit'
    );
    const said = errors.mock.calls.flat().join(' ');
    expect(said).toContain('SMTP_PORT');
    expect(said).not.toContain('ghp_secrettoken');
  });

  it('refuses a host carrying a scheme, a port or a line break', () => {
    for (const host of [
      'smtps://smtp.example.net',
      'smtp.example.net:587',
      'smtp.example.net\r\nQUIT',
      'user:pass@smtp.example.net',
    ]) {
      const { exit } = expectExit();
      expect(() => loadConfig(env({ SMTP_HOST: host }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      vi.restoreAllMocks();
    }
  });

  it('refuses an unknown TLS mode', () => {
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_TLS: 'ssl' }))).toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toContain('SMTP_TLS');
  });

  it('refuses a non-positive count', () => {
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_MAX_RECIPIENTS: '0' }))).toThrow('exit');
    expect(errors.mock.calls.flat().join(' ')).toContain('SMTP_MAX_RECIPIENTS');
  });

  it('warns about cleartext to a remote host but keeps going', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({ SMTP_TLS: 'none' }));
    expect(config.smtp.tls).toBe('none');
    expect(errors.mock.calls.flat().join(' ')).toContain('unencrypted');
  });

  it('does not warn about cleartext to a loopback host', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const host of ['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      loadConfig(env({ SMTP_TLS: 'none', SMTP_HOST: host }));
    }
    expect(errors.mock.calls.flat().join(' ')).not.toContain('unencrypted');
  });

  it('refuses an over-long signature', () => {
    const { errors } = expectExit();
    expect(() => loadConfig(env({ SMTP_SIGNATURE: 'x'.repeat(3000) }))).toThrow(
      'exit'
    );
    expect(errors.mock.calls.flat().join(' ')).toContain('SMTP_SIGNATURE');
  });

  it('keeps the tool-filter values unparsed', () => {
    const config = loadConfig(
      env({ SMTP_ALLOW_TOOLS: 'essential', SMTP_DENY_TOOLS: 'forward_mail' })
    );
    expect(config.allowTools).toBe('essential');
    expect(config.denyTools).toBe('forward_mail');
  });
});

describe('missingConfigMessage', () => {
  it('names every required variable and the send gate', () => {
    const message = missingConfigMessage(['SMTP_HOST']);
    expect(message).toContain('SMTP_HOST');
    expect(message).toContain('SMTP_FROM');
    expect(message).toContain('SMTP_ALLOW_SEND');
    expect(message).toContain('SMTP_ALLOWED_RECIPIENTS');
  });
});

describe('the default attachment types', () => {
  it('leave out the two shapes that carry a payload past the other checks', async () => {
    const { DEFAULT_ATTACHMENT_TYPES } = await import('../src/config.js');
    // An HTML file opens in a browser and gets none of the sanitising the HTML
    // part does; an archive passes the magic-byte check on its own bytes.
    expect(DEFAULT_ATTACHMENT_TYPES).not.toContain('text/html');
    expect(DEFAULT_ATTACHMENT_TYPES).not.toContain('application/zip');
    expect(DEFAULT_ATTACHMENT_TYPES).toContain('application/pdf');
  });

  it('can be widened back by the operator, in writing', async () => {
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig({
      SMTP_ATTACHMENT_TYPES: 'application/pdf, text/html',
    } as NodeJS.ProcessEnv);
    expect(config.allowedAttachmentTypes).toEqual([
      'application/pdf',
      'text/html',
    ]);
  });
});
