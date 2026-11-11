import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const folder = await mkdtemp(join(tmpdir(), "sales-e2e-"));
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATA_SOURCE: "demo",
  DEMO_DB_PATH: join(folder, "db"),
  PORT: "4195",
  HOST: "127.0.0.1",
  APP_ORIGIN: "http://127.0.0.1:4195",
  STATIC_DIR: "dist/client",
};
let child;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(folder, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const setup = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/demo-setup.ts"],
  { env, stdio: "inherit" },
);
const setupCode = await new Promise((resolve) => setup.once("exit", resolve));
if (setupCode !== 0) {
  await rm(folder, { recursive: true, force: true });
  process.exit(1);
}
child = spawn(process.execPath, ["dist/api/server/index.js"], {
  env,
  stdio: "inherit",
});
child.on("exit", async (code) => {
  if (!stopping) {
    await rm(folder, { recursive: true, force: true });
    process.exit(code ?? 1);
  }
});
