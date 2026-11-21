/**
 * Programmatic dialogs (rendered one at a time by <DialogHost />).
 *
 *   if (await confirm({ title: 'Clear history?', message: '…', confirmLabel: 'Clear', danger: true })) …
 *   const name = await prompt({ title: 'Rename folder', label: 'Name', initial: folder.title });
 *
 * `prompt` can validate synchronously (`validate`) or asynchronously (`submit`, keeps the dialog open and shows the
 * returned error message, e.g. a wrong access code).
 */

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  label: string;
  placeholder?: string;
  initial?: string;
  inputType?: 'text' | 'password' | 'url' | 'search';
  confirmLabel?: string;
  cancelLabel?: string;
  /** Returns an error message for invalid input, or null. */
  validate?: (value: string) => string | null;
  /** Async check; resolve null to accept, or an error message to keep the dialog open. */
  submit?: (value: string) => Promise<string | null>;
  /** Monospace input (URLs, codes). */
  mono?: boolean;
  autocomplete?: string;
}

export type DialogRequest =
  | ({ kind: 'confirm'; id: number; resolve: (value: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; id: number; resolve: (value: string | null) => void } & PromptOptions);

let nextId = 0;

class DialogQueue {
  queue = $state<DialogRequest[]>([]);

  get current(): DialogRequest | undefined {
    return this.queue[0];
  }

  settle(id: number): void {
    const i = this.queue.findIndex((r) => r.id === id);
    if (i >= 0) this.queue.splice(i, 1);
  }
}

export const dialogQueue = new DialogQueue();

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogQueue.queue.push({ kind: 'confirm', id: ++nextId, resolve, ...opts });
  });
}

export function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialogQueue.queue.push({ kind: 'prompt', id: ++nextId, resolve, ...opts });
  });
}
