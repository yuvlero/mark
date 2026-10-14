/** Single place for error construction and JSON output formatting. */
export class MarkError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

/** Normalise any thrown value into the public `{error, code, details?}` shape. */
export function errorJson(e: unknown): { error: string; code: string; details?: unknown } {
  const x = e as any;
  const code = x instanceof MarkError ? x.code : typeof x?.code === "string" ? x.code : "ERROR";
  const r: any = { error: String(x?.message ?? x).slice(0, 500), code };
  if (x instanceof MarkError && x.details !== undefined) r.details = x.details;
  return r;
}
/** JSON serialiser used by every adapter (bigint-safe). */
export const toJson = (o: unknown, indent = 2) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v), indent);
