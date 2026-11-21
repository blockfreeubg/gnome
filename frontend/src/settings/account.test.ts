import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { describeAuthError, fieldErrorSentence, passwordError, usernameError } from './account-forms';

const apiError = (status: number, code: ApiError['code'], message: string, fields?: Record<string, string>): ApiError =>
  new ApiError({ status, code, message, fromGnome: true, ...(fields ? { fields } : {}) });

describe('client-side account checks (docs/API.md rules)', () => {
  it('validates usernames like the server', () => {
    expect(usernameError('')).toMatch(/Enter/);
    expect(usernameError('ab')).toMatch(/3 to 32/);
    expect(usernameError('a'.repeat(33))).toMatch(/3 to 32/);
    expect(usernameError('bad name')).toMatch(/letters, digits/);
    expect(usernameError('good.name_1-x')).toBeNull();
  });

  it('counts password length in characters, as the server does', () => {
    expect(passwordError('')).toMatch(/Enter/);
    expect(passwordError('123456789')).toMatch(/at least 10/);
    expect(passwordError('1234567890')).toBeNull();
    // Six emoji are 12 UTF-16 units but 6 characters: the server rejects them, so the form must too.
    expect(passwordError('😀😀😀😀😀😀')).toMatch(/at least 10/);
    expect(passwordError('😀'.repeat(256))).toBeNull();
    expect(passwordError('😀'.repeat(257))).toMatch(/at most 256/);
    expect(passwordError(' '.repeat(12))).toMatch(/spaces/);
  });
});

describe('describeAuthError', () => {
  it('turns the server’s field fragments into sentences', () => {
    expect(fieldErrorSentence('current', 'is incorrect')).toBe('Current password is incorrect.');
    expect(fieldErrorSentence('username', 'must be 3–32 characters')).toBe('Username must be 3–32 characters.');
    expect(fieldErrorSentence('password', 'That password is too common.')).toBe('That password is too common.');
    expect(fieldErrorSentence('other', '')).toBe('This value is not valid.');
  });

  it('wrong password on account deletion is a field error, not a generic message', () => {
    const d = describeAuthError(apiError(422, 'validation_failed', 'validation failed', { password: 'is incorrect' }), 'session');
    expect(d.fields.password).toBe('Password is incorrect.');
  });

  it('a 401 means wrong credentials when signing in, but an ended session afterwards', () => {
    const err = apiError(401, 'unauthorized', 'invalid credentials');
    expect(describeAuthError(err).message).toBe('The username or password is not right.');
    expect(describeAuthError(err, 'session').message).toMatch(/no longer signed in/);
  });

  it('maps taken usernames, closed registration, rate limits and network failures', () => {
    expect(describeAuthError(apiError(409, 'conflict', 'that username is taken')).fields.username).toMatch(/taken/);
    expect(describeAuthError(apiError(403, 'forbidden', 'registration is closed on this server')).message).toBe(
      'Registration is closed on this server.',
    );
    const limited = new ApiError({ status: 429, code: 'rate_limited', message: 'slow down', retryAfterS: 30, fromGnome: true });
    expect(describeAuthError(limited).message).toBe('Too many attempts. Try again in 30 s.');
    expect(describeAuthError(new ApiError({ status: 0, code: 'network_error', message: 'x' })).message).toMatch(/Could not reach/);
  });
});
