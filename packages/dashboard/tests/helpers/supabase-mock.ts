import { vi } from "vitest";

/**
 * Per-table response config for the Supabase mock.
 *
 * `rows`        — terminal `await` of a select chain returns `{ data: rows }`
 * `single`      — `.single()` returns `{ data: single }`
 * `maybeSingle` — `.maybeSingle()` returns `{ data: maybeSingle }`
 * `count`       — terminal `await` of a `select(_, { count: "exact" })` chain returns `{ count }`
 * `selectError` / `updateError` / `insertError` / `deleteError` / `upsertError`
 *                — surface a Postgrest-shaped error on that operation
 */
export type MockTable = {
  rows?: unknown[];
  single?: unknown | null;
  maybeSingle?: unknown | null;
  count?: number;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
  insertError?: { message: string } | null;
  deleteError?: { message: string } | null;
  upsertError?: { message: string } | null;
};

export type SupabaseMockOpts = Record<string, MockTable>;

export type Capture = {
  selects: Array<{ table: string; cols: string }>;
  updates: Array<{
    table: string;
    data: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }>;
  inserts: Array<{ table: string; data: unknown }>;
  deletes: Array<{ table: string; filters: Array<[string, unknown]> }>;
  upserts: Array<{ table: string; data: unknown }>;
};

type Mode = "select" | "update" | "insert" | "delete" | "upsert";

/**
 * Chainable Supabase mock. Returns `{ client, capture }`:
 *   - `client` is shaped enough like the supabase-js client to satisfy dashboard
 *     query/action code (`.from().select().eq()...`, terminal `await` or
 *     `.single()`/`.maybeSingle()`).
 *   - `capture` collects every mutating call so tests can assert the exact
 *     update payload, filter set, and table.
 */
export function makeSupabaseMock(opts: SupabaseMockOpts = {}) {
  const capture: Capture = {
    selects: [],
    updates: [],
    inserts: [],
    deletes: [],
    upserts: [],
  };

  function makeBuilder(table: string) {
    let mode: Mode = "select";
    let cols = "";
    let countMode = false;
    const filters: Array<[string, unknown]> = [];
    let updateData: Record<string, unknown> | null = null;
    let upsertData: unknown | null = null;
    let insertData: unknown | null = null;

    const terminalSelect = () => {
      const t = opts[table];
      if (countMode) return { data: null, count: t?.count ?? 0, error: t?.selectError ?? null };
      return { data: t?.rows ?? [], error: t?.selectError ?? null };
    };

    const terminalUpdate = () => {
      if (updateData) {
        capture.updates.push({ table, data: updateData, filters: [...filters] });
      }
      const t = opts[table];
      return { data: null, error: t?.updateError ?? null };
    };

    const terminalInsert = () => {
      const t = opts[table];
      return { data: null, error: t?.insertError ?? null };
    };

    const terminalDelete = () => {
      capture.deletes.push({ table, filters: [...filters] });
      const t = opts[table];
      return { data: null, error: t?.deleteError ?? null };
    };

    const terminalUpsert = () => {
      const t = opts[table];
      return { data: null, error: t?.upsertError ?? null };
    };

    const builder: Record<string, unknown> = {};

    builder.select = vi.fn((selectCols?: string, options?: { count?: string; head?: boolean }) => {
      cols = selectCols ?? "*";
      if (options?.count) countMode = true;
      capture.selects.push({ table, cols });
      mode = "select";
      return builder;
    });

    builder.insert = vi.fn((data: unknown) => {
      mode = "insert";
      insertData = data;
      // Capture eagerly: the `insert().select().single()` pattern terminates on
      // .single() which goes through the select path, so deferring capture to
      // the terminal would lose the insert. Inserts have no filters to wait for.
      capture.inserts.push({ table, data });
      return builder;
    });

    builder.update = vi.fn((data: Record<string, unknown>) => {
      mode = "update";
      updateData = data;
      return builder;
    });

    builder.upsert = vi.fn((data: unknown) => {
      mode = "upsert";
      upsertData = data;
      capture.upserts.push({ table, data });
      return builder;
    });

    builder.delete = vi.fn(() => {
      mode = "delete";
      return builder;
    });

    builder.eq = vi.fn((col: string, val: unknown) => {
      filters.push([col, val]);
      return builder;
    });

    // Pass-throughs that don't change mode or capture filters
    const passThrough = [
      "neq",
      "in",
      "gte",
      "lte",
      "gt",
      "lt",
      "is",
      "not",
      "or",
      "order",
      "limit",
      "range",
      "match",
      "ilike",
      "like",
      "contains",
      "containedBy",
      "filter",
      "returns",
      "csv",
    ] as const;
    for (const m of passThrough) {
      builder[m] = vi.fn(() => builder);
    }

    builder.single = vi.fn(async () => {
      const t = opts[table];
      return { data: t?.single ?? null, error: t?.selectError ?? null };
    });

    builder.maybeSingle = vi.fn(async () => {
      const t = opts[table];
      return { data: t?.maybeSingle ?? null, error: t?.selectError ?? null };
    });

    // Thenable: awaiting the chain returns a mode-dependent terminal value.
    builder.then = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (v: unknown) => unknown,
    ) => {
      const result =
        mode === "update"
          ? terminalUpdate()
          : mode === "insert"
            ? terminalInsert()
            : mode === "delete"
              ? terminalDelete()
              : mode === "upsert"
                ? terminalUpsert()
                : terminalSelect();
      return Promise.resolve(result).then(onFulfilled, onRejected);
    };

    return builder;
  }

  const client = {
    from: vi.fn((table: string) => makeBuilder(table)),
  };

  return { client, capture };
}

/** Build a FormData object from a record. Most server actions accept FormData. */
export function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    fd.set(k, v);
  }
  return fd;
}
