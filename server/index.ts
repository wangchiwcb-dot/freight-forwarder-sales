import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

async function main() {
  const config = loadConfig();
  const db = await openDatabase(config);
  try {
    const migration = await db.query<{ version: number }>(
      "SELECT max(version) AS version FROM crm.migrations",
    );
    if (Number(migration.rows[0]?.version) !== 1)
      throw new Error("Database migration is missing");
  } catch {
    await db.close();
    throw new Error("数据库未准备好，请先显式运行迁移及账号初始化");
  }
  const app = await createApp({ db, config });
  const close = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await app.listen({ host: config.host, port: config.port });
  console.log(
    `Sales workbench ready on ${config.host}:${config.port} (${config.source})`,
  );
}
main().catch(() => {
  console.error(
    "Sales workbench failed to start. Check configuration and database readiness.",
  );
  process.exitCode = 1;
});
