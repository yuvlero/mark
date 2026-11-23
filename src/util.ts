/** Tiny shared helpers (no dependencies). */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The value if it is a string, else undefined (CLI flag values: `--flag` alone parses as true). */
export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
