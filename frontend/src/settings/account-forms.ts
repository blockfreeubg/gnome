/**
 * Checks and wording for the account forms (Settings → Account & sync): the username and password rules of
 * docs/API.md "Accounts" (also enforced by the server) and one sentence per auth failure. Loaded with the Settings
 * page only; the signed-in state itself lives in account.svelte.ts.
 */
import { ApiError } from '../lib/api';

/** Username rule from docs/API.md (also checked by the server). */
export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export function usernameError(name: string): string | null {
  if (!name) return 'Enter a username.';
  if (name.length < 3 || name.length > 32) return 'Use 3 to 32 characters.';
  if (!USERNAME_RE.test(name)) return 'Use letters, digits, dots, dashes and underscores only.';
  return null;
}

export function passwordError(pw: string): string | null {
  if (!pw) return 'Enter a password.';
  // The server counts characters (code points), not UTF-16 units: "😀" is one character there.
  const length = [...pw].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (!pw.trim()) return 'Use more than spaces.';
  return null;
}

/** Labels for the request fields the auth endpoints report errors on (docs/API.md "Accounts"). */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  username: 'Username',
  password: 'Password',
  current: 'Current password',
  next: 'New password',
};

/**
 * The server words field errors as fragments ("is incorrect", "must be 3–32 characters"); forms show sentences
 * ("Current password is incorrect.").
 */
export function fieldErrorSentence(field: string, message: string): string {
  const m = message.trim();
  if (!m) return `${FIELD_LABELS[field] ?? 'This value'} is not valid.`;
  const end = /[.!?]$/.test(m) ? '' : '.';
  if (/^[A-Z]/.test(m)) return `${m}${end}`;
  return `${FIELD_LABELS[field] ?? 'This value'} ${m}${end}`;
}

/**
 * Turns an auth failure into one sentence for the form (field errors are returned separately, as sentences).
 * `context`: `sign-in` for login/register; `session` for requests made while signed in (password change, account
 * deletion, sign-out), where a 401 means the session ended rather than a wrong password.
 */
export function describeAuthError(
  err: unknown,
  context: 'sign-in' | 'session' = 'sign-in',
): { message: string; fields: Record<string, string> } {
  if (err instanceof ApiError) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(err.fields ?? {})) {
      if (typeof v === 'string') fields[k] = fieldErrorSentence(k, v);
    }
    switch (err.code) {
      case 'unauthorized':
        if (context === 'session') return { message: 'You are no longer signed in. Sign in again to continue.', fields };
        return { message: 'The username or password is not right.', fields };
      case 'login_required':
        return { message: 'You are no longer signed in. Sign in again to continue.', fields };
      case 'validation_failed':
        return { message: 'Check the highlighted fields.', fields };
      case 'conflict':
        return { message: 'That username is taken.', fields: { username: 'That username is taken.' } };
      case 'rate_limited':
        return {
          message: err.retryAfterS ? `Too many attempts. Try again in ${err.retryAfterS} s.` : 'Too many attempts. Try again shortly.',
          fields,
        };
      case 'forbidden':
        return { message: err.fromGnome ? capitalize(err.message) : 'The server refused the request.', fields };
      case 'not_found':
        return { message: 'This server does not offer accounts.', fields };
      case 'network_error':
      case 'timeout':
        return { message: 'Could not reach the GNOME server. Check your connection and try again.', fields };
      default:
        return { message: err.message || 'Something went wrong.', fields };
    }
  }
  return { message: err instanceof Error ? err.message : 'Something went wrong.', fields: {} };
}

function capitalize(s: string): string {
  const t = s.trim();
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t;
}
