/** Tiny shared helpers (no dependencies). */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
