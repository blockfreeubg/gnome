/**
 * The account's copy of the history (API.md "History"). `DELETE /api/sync/history {"all": true}` removes it and
 * records `cleared_before`; the user's other devices drop their copies of older visits at their next sync
 * (HistoryStore sync adapter, applyRemote). The API can only clear everything before a time, so only "All time" on
 * the History page offers it; removing single visits or a recent range stays local.
 */
import { api } from '../lib/api';
import { account } from '../settings/account.svelte';
import { settings } from '../settings/store.svelte';
import { requestRecordSync } from '../settings/sync';

/** Whether this browser syncs its history with the signed-in account (reactive in components). */
export function historySynced(): boolean {
  const a = settings.value.account;
  return !!account.user && account.syncAvailable && a.sync && a.syncHistory;
}

/** Clears the history on the account; the next sync tells this device's cursor about it. */
export async function clearSyncedHistory(): Promise<void> {
  await api.delete('/api/sync/history', { all: true }, { timeoutMs: 30_000 });
  requestRecordSync('history');
}
