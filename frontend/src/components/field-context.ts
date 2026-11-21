/** Context that wires a Field/SettingRow label, help and error text to the control inside it. */
import { getContext, setContext } from 'svelte';

export interface FieldContext {
  /** id for the control element (label[for] points at it). */
  readonly controlId: string;
  readonly labelId: string;
  /** Space-separated ids for aria-describedby (help + error), or undefined. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
}

const KEY = Symbol('gnome-field');

export function setFieldContext(ctx: FieldContext): void {
  setContext(KEY, ctx);
}

export function getFieldContext(): FieldContext | undefined {
  return getContext<FieldContext | undefined>(KEY);
}
