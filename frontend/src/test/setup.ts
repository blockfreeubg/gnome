/**
 * Vitest setup (node environment): in-memory Web Storage for `localStorage` / `sessionStorage`, so modules that mirror
 * state to storage can be tested (Node's own experimental localStorage needs a file flag and warns otherwise).
 */

export class MemoryStorage implements Storage {
  #data = new Map<string, string>();

  get length(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  getItem(key: string): string | null {
    return this.#data.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#data.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#data.set(String(key), String(value));
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
}
