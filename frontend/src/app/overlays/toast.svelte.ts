/**
 * Programmatic toasts.
 *
 *   toast.success('Bookmark added');
 *   toast.error('Could not reach the server', { description: err.message, actions: [{ label: 'Retry', onClick }] });
 *   const id = toast.show({ title: 'Downloading…', duration: null }); … toast.dismiss(id);
 */
import { announce } from '../announcer.svelte';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
  /** Dismiss the toast after the action runs (default true). */
  dismiss?: boolean;
}

export interface ToastOptions {
  title: string;
  description?: string;
  kind?: ToastKind;
  actions?: ToastAction[];
  /** Milliseconds before auto-dismiss; null keeps it until dismissed. Default 5 s (8 s with actions or errors). */
  duration?: number | null;
  /** Reuse an id to update an existing toast instead of stacking a new one. */
  id?: string;
}

export interface ToastItem {
  id: string;
  title: string;
  description: string | undefined;
  kind: ToastKind;
  actions: ToastAction[];
  duration: number | null;
  version: number;
}

const MAX_TOASTS = 4;
let counter = 0;

class ToastStore {
  items = $state<ToastItem[]>([]);

  show(opts: ToastOptions): string {
    const kind = opts.kind ?? 'info';
    const actions = opts.actions ?? [];
    const duration = opts.duration === undefined ? (actions.length || kind === 'error' ? 8000 : 5000) : opts.duration;
    const id = opts.id ?? `toast-${++counter}`;
    const existing = this.items.findIndex((t) => t.id === id);
    const item: ToastItem = {
      id,
      title: opts.title,
      description: opts.description,
      kind,
      actions,
      duration,
      version: (this.items[existing]?.version ?? 0) + 1,
    };
    if (existing >= 0) this.items[existing] = item;
    else {
      this.items.push(item);
      while (this.items.length > MAX_TOASTS) {
        const victim = this.items.findIndex((t) => t.duration !== null);
        this.items.splice(victim >= 0 ? victim : 0, 1);
      }
    }
    announce([opts.title, opts.description].filter(Boolean).join('. '), kind === 'error' ? 'assertive' : 'polite');
    return id;
  }

  info(title: string, opts: Omit<ToastOptions, 'title' | 'kind'> = {}): string {
    return this.show({ ...opts, title, kind: 'info' });
  }

  success(title: string, opts: Omit<ToastOptions, 'title' | 'kind'> = {}): string {
    return this.show({ ...opts, title, kind: 'success' });
  }

  warning(title: string, opts: Omit<ToastOptions, 'title' | 'kind'> = {}): string {
    return this.show({ ...opts, title, kind: 'warning' });
  }

  error(title: string, opts: Omit<ToastOptions, 'title' | 'kind'> = {}): string {
    return this.show({ ...opts, title, kind: 'error' });
  }

  dismiss(id: string): void {
    const i = this.items.findIndex((t) => t.id === id);
    if (i >= 0) this.items.splice(i, 1);
  }

  clear(): void {
    this.items.length = 0;
  }
}

export const toast = new ToastStore();
