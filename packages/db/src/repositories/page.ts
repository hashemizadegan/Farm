/** Keyset pages for list endpoints: the cursor is the id of the last row of the previous page. */
import type { TenantTx } from "../tenant";

export interface PageRequest {
  /** Rows per page; list functions return up to `limit + 1` rows so the caller can tell whether more follow. */
  limit: number;
  /** Id of the last row of the previous page. */
  after?: string;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("the cursor does not name a row of this list");
    this.name = "InvalidCursorError";
  }
}

/** Refuses a cursor that is not a row of the list (in this tenant), instead of returning an empty page. */
export async function assertCursor(tx: TenantTx, existsSql: string, after: string | undefined): Promise<void> {
  if (after === undefined) return;
  if (!(await tx.query(existsSql, [tx.tenantId, after])).rowCount) throw new InvalidCursorError();
}

/** Splits `limit + 1` rows into the page and the next cursor (the last row's id), or null at the end. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): { rows: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}
