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
