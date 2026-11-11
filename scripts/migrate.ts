import { readFile } from "node:fs/promises";
import pg from "pg";
import { resolve } from "node:path";

async function migrate() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      "Provide MIGRATION_DATABASE_URL in a protected environment file.",
    );
  const target = new URL(url).pathname.slice(1);
  if (!/^sales_workbench(?:_[a-z0-9_]+)?$/.test(target))
    throw new Error("Only a dedicated sales_workbench database is allowed.");
  if (!process.argv.includes(`--confirm-target=${target}`))
    throw new Error(`Explicit migration requires --confirm-target=${target}`);
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const actual = (await client.query("SELECT current_database() AS name"))
      .rows[0].name;
    if (actual !== target) throw new Error("Database target mismatch.");
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('sales-workbench:migration',0))",
    );
    const exists = (
      await client.query("SELECT to_regclass('crm.migrations') AS name")
    ).rows[0].name;
    if (exists) {
      const versions = (
        await client.query(
          "SELECT version FROM crm.migrations ORDER BY version",
        )
      ).rows;
      if (versions.length !== 1 || versions[0].version !== 1)
        throw new Error("Unexpected database version; review migration state.");
      console.log("Database is already at version 1. No schema changed.");
    } else {
      const schemaExists = (
        await client.query("SELECT 1 FROM pg_namespace WHERE nspname='crm'")
      ).rowCount;
      if (schemaExists)
        throw new Error(
          "Unregistered CRM schema exists. Refusing to overwrite.",
        );
      await client.query(
        await readFile(resolve("database/001_crm.sql"), "utf8"),
      );
      console.log("Applied CRM migration version 1.");
    }
    await client.query(await readFile(resolve("database/roles.sql"), "utf8"));
    console.log(
      "Applied dedicated application permissions. No business records seeded.",
    );
  } catch (error) {
    console.error(
      "Migration failed. Review the target and database privileges; no connection details are printed.",
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
void migrate().catch(() => {
  console.error(
    "Migration refused. Check the protected connection file, dedicated database name, and --confirm-target argument.",
  );
  process.exitCode = 1;
});
