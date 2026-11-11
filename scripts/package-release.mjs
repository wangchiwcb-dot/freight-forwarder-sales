import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const stage = await mkdtemp(join(tmpdir(), "sales-release-"));
const id = new Date().toISOString().replace(/[:.]/g, "-");
const output = `artifacts/freight-sales-${pkg.version}-${id}.tar.gz`;
try {
  await mkdir("artifacts", { recursive: true });
  // Explicit allowlist: never include local data, node_modules, secrets or test output.
  for (const path of [
    "dist",
    "database",
    "deploy",
    "docs",
    "scripts",
    "server",
    "shared",
    "package.json",
    "package-lock.json",
    "README.md",
    ".env.example",
  ])
    await cp(path, join(stage, path), { recursive: true });
  await writeFile(
    join(stage, "RELEASE.json"),
    JSON.stringify(
      {
        version: pkg.version,
        createdAt: new Date().toISOString(),
        schemaVersion: 1,
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync("tar", ["-czf", output, "-C", stage, "."]);
  const digest = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  await writeFile(
    output + ".sha256",
    digest + "  " + output.split("/").at(-1) + "\n",
  );
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
