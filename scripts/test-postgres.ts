import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "pg";

// Always creates its own throwaway cluster. No supplied DATABASE_URL is used.
const root = await mkdtemp(join(tmpdir(), "sales-workbench-pg-"));
const port = await new Promise<number>((resolve, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    socket.close((error) => (error ? reject(error) : resolve(selected)));
  });
});
const password = randomBytes(32).toString("hex");
const runtimePassword = randomBytes(32).toString("hex");
const cluster = new EmbeddedPostgres({
  databaseDir: join(root, "cluster"),
  user: "qa_owner",
  password,
  port,
  authMethod: "scram-sha-256",
  persistent: true,
  createPostgresUser: false,
  autoRehydrateSymlinks: true,
  postgresFlags: [
    "-h",
    "127.0.0.1",
    "-k",
    root,
    "-c",
    "max_connections=40",
    "-c",
    "log_statement=none",
  ],
  onLog: () => {},
  onError: () => {},
});
let child: ChildProcess | undefined;
let started = false;
let stopping: Promise<void> | undefined;
async function cleanup() {
  if (!stopping)
    stopping = (async () => {
      if (started) await cluster.stop();
      await rm(root, { recursive: true, force: true });
    })();
  await stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    child?.kill(signal);
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
const previousUmask = process.umask(0o077);
try {
  await cluster.initialise();
  await cluster.start();
  started = true;
  await cluster.createDatabase("sales_workbench_test");
  const adminUrl = `postgresql://qa_owner:${password}@127.0.0.1:${port}/sales_workbench_test`;
  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  try {
    await owner.query(await readFile("database/001_crm.sql", "utf8"));
    await owner.query(await readFile("database/roles.sql", "utf8"));
    // Random hexadecimal only; credentials never enter logs or command arguments.
    await owner.query(
      `ALTER ROLE sales_workbench_api LOGIN PASSWORD '${runtimePassword}'`,
    );
    await owner.query("CREATE DATABASE forbidden_sales_qa");
    await owner.query(
      "REVOKE CONNECT ON DATABASE forbidden_sales_qa FROM PUBLIC",
    );
  } finally {
    await owner.end();
  }
  console.log(
    "Isolated PostgreSQL initialized; running role and concurrent API checks.",
  );
  const code = await new Promise<number>((resolve, reject) => {
    child = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "tests/postgres.test.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          QA_ISOLATED_PG: "1",
          QA_PG_ADMIN_URL: adminUrl,
          QA_PG_RUNTIME_URL: `postgresql://sales_workbench_api:${runtimePassword}@127.0.0.1:${port}/sales_workbench_test`,
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  process.exitCode = code;
} catch (error) {
  // Avoid leaking a connection URL from driver errors.
  const message =
    error instanceof Error
      ? error.message.replace(
          /postgres(?:ql)?:\/\/\S+/g,
          "[connection redacted]",
        )
      : "PostgreSQL verification failed";
  console.error(message);
  process.exitCode = 1;
} finally {
  process.umask(previousUmask);
  await cleanup();
}
