import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { openDatabase } from "../server/db.js";
import { hashPassword, passwordSchema } from "../server/auth.js";
async function bootstrap() {
  const file = process.argv[process.argv.indexOf("--credentials") + 1];
  if (!process.argv.includes("--credentials") || !file)
    throw new Error(
      "Provide --credentials with a protected JSON file, not password arguments.",
    );
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0)
    throw new Error(
      "Credentials file must be readable by its owner only (0600).",
    );
  const credentials = z
    .object({
      username: z.string().trim().min(1).max(100),
      displayName: z.string().trim().min(1).max(100),
      password: passwordSchema,
    })
    .strict()
    .parse(JSON.parse(await readFile(file, "utf8")));
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (
    !databaseUrl ||
    !/^\/sales_workbench(?:_[a-z0-9_]+)?$/.test(new URL(databaseUrl).pathname)
  )
    throw new Error(
      "A dedicated sales_workbench migration connection is required.",
    );
  const tenant = process.env.TENANT_ID ?? "szzhhq";
  const db = await openDatabase({ source: "postgres", databaseUrl });
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('sales-workbench:bootstrap',0))",
      );
      if ((await tx.query("SELECT 1 FROM crm.users LIMIT 1")).rows.length)
        throw new Error("Bootstrap refused: users already exist.");
      await tx.query(
        "INSERT INTO crm.tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
        [tenant, "中航环球"],
      );
      await tx.query(
        "INSERT INTO crm.users(tenant_id,username,display_name,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,true)",
        [
          tenant,
          credentials.username,
          credentials.displayName,
          "admin",
          await hashPassword(credentials.password),
        ],
      );
    });
    console.log(
      "Initial administrator created. First sign-in requires changing the password.",
    );
  } catch {
    console.error("Bootstrap refused or failed. No credentials printed.");
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
void bootstrap().catch(() => {
  console.error(
    "Bootstrap refused. Check the owner-only credentials file and dedicated database connection.",
  );
  process.exitCode = 1;
});
