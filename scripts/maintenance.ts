import pg from "pg";
const url = process.env.MAINTENANCE_DATABASE_URL;
if (!url)
  throw new Error(
    "Provide a dedicated maintenance connection in a protected environment.",
  );
const client = new pg.Client({
  connectionString: url,
  connectionTimeoutMillis: 5000,
});
try {
  await client.connect();
  const name = (await client.query("SELECT current_database() AS name")).rows[0]
    .name;
  if (!/^sales_workbench(?:_[a-z0-9_]+)?$/.test(name))
    throw new Error("Invalid maintenance target.");
  await client.query("BEGIN");
  await client.query(
    "DELETE FROM crm.sessions WHERE expires_at < now() - interval '7 days'",
  );
  await client.query(
    "DELETE FROM crm.idempotency_keys WHERE expires_at < now()",
  );
  await client.query("COMMIT");
  console.log(
    "Expired session and idempotency records removed. Business history preserved.",
  );
} catch {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Maintenance failed. No connection details printed.");
  process.exitCode = 1;
} finally {
  await client.end();
}
