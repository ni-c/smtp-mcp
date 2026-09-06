/** How much of a rejected configuration value a diagnostic repeats. */
const MAX_SHOWN = 40;

/**
 * A rejected value as a startup diagnostic may repeat it.
 *
 * Config errors end up in logs, and the branch that rejects a value is where
 * a token pasted into the wrong variable arrives — so the value is cut short,
 * and control characters go so it cannot rewrite the line it is printed on.
 */
export function shown(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching them is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return clean.length > MAX_SHOWN ? `${clean.slice(0, MAX_SHOWN)}…` : clean;
}

/** Errors that come from the caller's arguments rather than from the server. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * An SMTP failure, carrying whatever the server said.
 *
 * `responseText` is upstream output and gets the same truncation treatment as
 * any other remote string before it reaches the model. Note what is *not* kept:
 * nodemailer's error objects hold the command that was sent, and for an AUTH
 * that means the credentials.
 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined = undefined,
    readonly responseText: string = ''
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}
