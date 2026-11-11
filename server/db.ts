import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Database extends Queryable {
  transaction<T>(
    fn: (tx: Queryable) => Promise<T>,
    options?: { readOnly?: boolean },
  ): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(options: {
  source: "demo" | "postgres";
  databaseUrl?: string;
  demoPath?: string;
}): Promise<Database> {
  if (options.source === "postgres") {
    if (!options.databaseUrl)
      throw new Error("PostgreSQL connection configuration is required");
    const pool = new Pool({
      connectionString: options.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
    });
    const adapt = (client: { query: Pool["query"] }): Queryable => ({
      async query<T>(text: string, values: unknown[] = []) {
        const r = await client.query(text, values);
        return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
      },
    });
    return {
      ...adapt(pool),
      async transaction<T>(
        fn: (tx: Queryable) => Promise<T>,
        txOptions?: { readOnly?: boolean },
      ) {
        const client = await pool.connect();
        try {
          await client.query(
            txOptions?.readOnly
              ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
              : "BEGIN",
          );
          await client.query("SET LOCAL lock_timeout = '5s'");
          const result = await fn(adapt(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const pg = new PGlite(options.demoPath ?? ".data/demo-db");
  await pg.waitReady;
  const adapt = (client: { query: PGlite["query"] }): Queryable => ({
    async query<T>(text: string, values: unknown[] = []) {
      const r = await client.query<T>(text, values);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    ...adapt(pg),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return pg.transaction((tx) => fn(adapt(tx)));
    },
    close: () => pg.close(),
  };
}
