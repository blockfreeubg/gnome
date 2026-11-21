<!-- Sign in / create account / signed-in summary with password change and account deletion (/api/auth/*). -->
<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import Button from '../../components/Button.svelte';
  import Dialog from '../../components/Dialog.svelte';
  import Field from '../../components/Field.svelte';
  import Icon from '../../components/Icon.svelte';
  import IconButton from '../../components/IconButton.svelte';
  import Input from '../../components/Input.svelte';
  import Logo from '../../components/Logo.svelte';
  import Spinner from '../../components/Spinner.svelte';
  import { toast } from '../../app/overlays/toast.svelte';
  import { server } from '../../app/server.svelte';
  import { isApiError } from '../../lib/api';
  import { formatDateTime } from '../../lib/format';
  import { account } from '../../settings/account.svelte';
  import { describeAuthError, passwordError, usernameError } from '../../settings/account-forms';

  let mode = $state<'login' | 'register'>('login');
  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let busy = $state(false);
  let showPassword = $state(false);
  let formError = $state<string | null>(null);
  let fieldErrors = $state<Record<string, string>>({});

  const canRegister = $derived(account.registrationOpen);
  let retrying = $state(false);

  async function retryCheck(): Promise<void> {
    retrying = true;
    await account.refresh().catch(() => undefined);
    retrying = false;
  }

  $effect(() => {
    if (!canRegister && mode === 'register') mode = 'login';
  });

  function switchMode(next: 'login' | 'register'): void {
    mode = next;
    formError = null;
    fieldErrors = {};
  }

  /** The avatar's letter: the first character of the username, upper-cased. */
  function initial(name: string): string {
    return (Array.from(name.trim())[0] ?? '?').toUpperCase();
  }

  async function submit(ev: SubmitEvent): Promise<void> {
    ev.preventDefault();
    formError = null;
    const errs: Record<string, string> = {};
    if (mode === 'register') {
      const u = usernameError(username.trim());
      if (u) errs.username = u;
      const p = passwordError(password);
      if (p) errs.password = p;
      if (!errs.password && password !== confirm) errs.confirm = 'The passwords do not match.';
    } else {
      if (!username.trim()) errs.username = 'Enter your username.';
      if (!password) errs.password = 'Enter your password.';
    }
    fieldErrors = errs;
    if (Object.keys(errs).length) return;
    busy = true;
    try {
      const user = mode === 'register' ? await account.register(username.trim(), password) : await account.login(username.trim(), password);
      toast.success(mode === 'register' ? 'Account created' : 'Signed in', { description: `Signed in as ${user.username}.` });
      password = '';
      confirm = '';
      showPassword = false;
    } catch (err) {
      const d = describeAuthError(err);
      formError = d.message;
      fieldErrors = d.fields;
    } finally {
      busy = false;
    }
  }

  async function signOut(): Promise<void> {
    busy = true;
    try {
      await account.logout();
      toast.info('Signed out', { description: 'Your settings and data stay in this browser.' });
    } catch (err) {
      toast.error('Could not sign out', { description: `${describeAuthError(err, 'session').message} You are still signed in.` });
    } finally {
      busy = false;
    }
  }

  // Password change
  let pwOpen = $state(false);
  let pwCurrent = $state('');
  let pwNext = $state('');
  let pwConfirm = $state('');
  let pwErrors = $state<Record<string, string>>({});
  let pwError = $state<string | null>(null);
  let pwBusy = $state(false);

  function openPassword(): void {
    pwCurrent = pwNext = pwConfirm = '';
    pwErrors = {};
    pwError = null;
    pwOpen = true;
  }

  async function changePassword(ev?: SubmitEvent): Promise<void> {
    ev?.preventDefault();
    const errs: Record<string, string> = {};
    if (!pwCurrent) errs.current = 'Enter your current password.';
    const p = passwordError(pwNext);
    if (p) errs.next = p;
    else if (pwNext !== pwConfirm) errs.confirm = 'The passwords do not match.';
    pwErrors = errs;
    pwError = null;
    if (Object.keys(errs).length) return;
    pwBusy = true;
    try {
      await account.changePassword(pwCurrent, pwNext);
      pwOpen = false;
      toast.success('Password changed', { description: 'Other browsers signed in to this account were signed out.' });
    } catch (err) {
      // A wrong current password is a field error (422 `fields.current`); a 401 here means the session ended.
      const d = describeAuthError(err, 'session');
      pwErrors = d.fields;
      pwError = d.fields.current || d.fields.next ? null : d.message;
      if (isApiError(err, 'unauthorized')) void account.refresh().catch(() => {});
    } finally {
      pwBusy = false;
    }
  }

  // Account deletion
  let delOpen = $state(false);
  let delPassword = $state('');
  let delError = $state<string | null>(null);
  let delBusy = $state(false);

  async function deleteAccount(ev?: SubmitEvent): Promise<void> {
    ev?.preventDefault();
    if (!delPassword) {
      delError = 'Enter your password to confirm.';
      return;
    }
    delBusy = true;
    delError = null;
    try {
      const name = account.user?.username ?? '';
      await account.deleteAccount(delPassword);
      delOpen = false;
      toast.info('Account deleted', { description: `${name} and everything synced to it were removed from this server.` });
    } catch (err) {
      // A wrong password is a field error (422 `fields.password`); a 401 here means the session ended.
      const d = describeAuthError(err, 'session');
      delError = d.fields.password ?? d.message;
      if (isApiError(err, 'unauthorized')) void account.refresh().catch(() => {});
    } finally {
      delBusy = false;
      delPassword = '';
    }
  }
</script>

<div class="card glass-card" aria-busy={!account.checked && server.config !== null && !!server.config?.features.accounts}>
  <div class="brand" aria-hidden="true">
    <Logo size={34} decorative />
    <span class="brand-word">GNOME</span>
  </div>

  {#if server.config === null}
    <h4 class="title">Account</h4>
    {#if server.reachable === false}
      <p class="sub">The GNOME server is not reachable, so accounts are unavailable right now. Everything else keeps working in this browser.</p>
    {:else}
      <p class="sub status"><Spinner size={14} /> Contacting the server…</p>
    {/if}
  {:else if !server.config.features.accounts}
    <h4 class="title">Account</h4>
    <p class="sub">This server does not offer accounts. Your settings and data stay in this browser.</p>
  {:else if !account.checked}
    <h4 class="title">Account</h4>
    <p class="sub status"><Spinner size={14} /> Checking whether you are signed in…</p>
  {:else if account.error && !account.user}
    <h4 class="title">Account</h4>
    <p class="sub">{account.error} Whether you are signed in is not known yet.</p>
    <Button variant="outline" size="lg" full loading={retrying} onclick={retryCheck}>Try again</Button>
  {:else if account.user}
    <div class="who">
      <span class="avatar" aria-hidden="true">{initial(account.user.username)}</span>
      <div class="who-text">
        <h4 class="title name">{account.user.username}</h4>
        <p class="sub">
          Account created {formatDateTime(account.user.created_at)}{#if account.user.is_admin}<span class="role">Administrator</span>{/if}
        </p>
      </div>
    </div>
    <div class="actions">
      <Button variant="inverse" size="lg" full icon={LogOut} loading={busy} onclick={signOut}>Sign out</Button>
      <Button variant="outline" size="lg" full icon={KeyRound} onclick={openPassword}>Change password</Button>
      <Button variant="outline" size="lg" full icon={Trash2} class="danger-outline" onclick={() => ((delOpen = true), (delError = null))}>Delete account</Button>
    </div>
  {:else}
    <h4 class="title">{mode === 'register' ? 'Create an account' : 'Sign in'}</h4>
    <p class="sub">
      {mode === 'register'
        ? 'Your account lives on this GNOME server. Nothing syncs until you turn sync on.'
        : 'Keep your settings in sync across your browsers.'}
    </p>
    <form class="form" onsubmit={submit} novalidate>
      <Field label="Username" error={fieldErrors.username ?? null} help={mode === 'register' ? '3–32 letters, digits, dots, dashes or underscores.' : undefined}>
        <Input bind:value={username} size="lg" placeholder="Your username" autocomplete="username" spellcheck={false} autocapitalize="none" maxlength={32} />
      </Field>
      <Field label="Password" error={fieldErrors.password ?? null} help={mode === 'register' ? 'At least 10 characters.' : undefined}>
        <Input
          bind:value={password}
          size="lg"
          type={showPassword ? 'text' : 'password'}
          placeholder={mode === 'register' ? 'Choose a password' : 'Your password'}
          autocomplete={mode === 'register' ? 'new-password' : 'current-password'}
          maxlength={256}
        >
          {#snippet trailing()}
            <IconButton
              icon={showPassword ? EyeOff : Eye}
              label={showPassword ? 'Hide password' : 'Show password'}
              pressed={showPassword}
              size="sm"
              tooltip={false}
              onclick={() => (showPassword = !showPassword)}
            />
          {/snippet}
        </Input>
      </Field>
      {#if mode === 'register'}
        <Field label="Confirm password" error={fieldErrors.confirm ?? null}>
          <Input bind:value={confirm} size="lg" type={showPassword ? 'text' : 'password'} placeholder="Type it again" autocomplete="new-password" maxlength={256} />
        </Field>
      {/if}
      {#if formError}<p class="form-error" role="alert"><Icon icon={CircleAlert} size={16} />{formError}</p>{/if}
      <Button type="submit" variant="primary" size="lg" full loading={busy} class="submit">{mode === 'register' ? 'Create account' : 'Sign in'}</Button>
    </form>
    <p class="switch">
      {#if canRegister}
        {#if mode === 'login'}
          No account yet? <button type="button" class="link" onclick={() => switchMode('register')}>Create one</button>
        {:else}
          Already have an account? <button type="button" class="link" onclick={() => switchMode('login')}>Sign in instead</button>
        {/if}
      {:else}
        New accounts are created by this server’s operator.
      {/if}
    </p>
  {/if}
</div>

<Dialog bind:open={pwOpen} title="Change password" description="Other browsers signed in to this account will be signed out." size="sm">
  <form id="pw-form" class="dlg-form" onsubmit={changePassword} novalidate>
    <Field label="Current password" error={pwErrors.current ?? null}>
      <Input bind:value={pwCurrent} size="lg" type="password" autocomplete="current-password" maxlength={256} />
    </Field>
    <Field label="New password" error={pwErrors.next ?? null} help="At least 10 characters.">
      <Input bind:value={pwNext} size="lg" type="password" autocomplete="new-password" maxlength={256} />
    </Field>
    <Field label="Confirm new password" error={pwErrors.confirm ?? null}>
      <Input bind:value={pwConfirm} size="lg" type="password" autocomplete="new-password" maxlength={256} />
    </Field>
    {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (pwOpen = false)}>Cancel</Button>
    <Button variant="primary" type="submit" form="pw-form" loading={pwBusy}>Change password</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={delOpen} title="Delete account?" role="alertdialog" description="Your account and everything synced to it are removed from this server. Data in this browser stays." size="sm">
  <form id="del-form" class="dlg-form" onsubmit={deleteAccount} novalidate>
    <Field label="Password" error={delError}>
      <Input bind:value={delPassword} size="lg" type="password" autocomplete="current-password" maxlength={256} />
    </Field>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (delOpen = false)}>Cancel</Button>
    <Button variant="danger" type="submit" form="del-form" loading={delBusy}>Delete account</Button>
  {/snippet}
</Dialog>

<style>
  /* The ivy sign-in card (DESIGN.md §12): brand row, bold title, wells, one accent action, quiet tertiary actions. */
  .card {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 400px;
    padding: var(--space-8) 28px 26px;
  }

  .brand {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: var(--space-5);
    color: var(--text);
  }

  .brand-word {
    font-family: var(--font-display);
    font-weight: var(--weight-wordmark, 800);
    font-size: 1.5714rem;
    letter-spacing: -0.04em;
    line-height: 1;
    transform: translateY(0.1em);
  }

  .title {
    font-family: var(--font-display);
    font-variation-settings: var(--display-variation);
    font-weight: var(--weight-display);
    font-size: var(--text-2xl);
    letter-spacing: var(--tracking-display);
    line-height: var(--lh-display);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .sub {
    margin-top: 6px;
    font-size: 0.9286rem;
    font-weight: 500;
    color: var(--text-3);
    line-height: 1.5;
  }

  .sub.status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .sub + :global(.btn) {
    margin-top: var(--space-5);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-top: var(--space-6);
  }

  .form :global(.submit) {
    margin-top: var(--space-1);
    border-radius: var(--radius-lg);
  }

  .form-error {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 10px var(--space-3);
    border-radius: var(--radius);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 1.45;
  }

  .form-error :global(svg) {
    flex: none;
    margin-top: 1px;
  }

  .switch {
    margin-top: var(--space-5);
    text-align: center;
    font-size: 0.9286rem;
    font-weight: 500;
    color: var(--text-3);
  }

  .link {
    padding: 2px 2px;
    margin: -2px 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .link:hover {
    color: var(--accent-strong);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .link:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .dlg-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .error {
    font-size: var(--text-sm);
    color: var(--danger);
  }

  /* Signed in */
  .who {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .avatar {
    display: grid;
    place-items: center;
    flex: none;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hairline-strong);
    color: var(--text);
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 1.4286rem;
  }

  .who-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .who .sub {
    margin-top: 4px;
  }

  /* Long usernames (up to 32 characters) wrap evenly instead of leaving one character on the last line. */
  .who .name {
    text-wrap: balance;
  }

  @media (max-width: 759px) {
    .who .name {
      font-size: var(--text-xl);
    }
  }

  .role {
    display: inline-block;
    margin-left: var(--space-2);
    padding: 1px 8px;
    border-radius: var(--radius-pill);
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: var(--text-xs);
    font-weight: 600;
    vertical-align: 1px;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-6);
  }

  .actions :global(.danger-outline) {
    color: var(--danger);
  }

  @media (max-width: 759px) {
    .card {
      max-width: none;
      padding: var(--space-6) var(--space-5) var(--space-5);
    }
  }
</style>
