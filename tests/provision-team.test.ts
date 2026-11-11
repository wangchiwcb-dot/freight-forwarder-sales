import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, type Database } from "../server/db.js";
import { verifyPassword } from "../server/auth.js";
import {
  parseProvisionOptions,
  provisionTeam,
  readTeamRoster,
  type TeamRoster,
} from "../scripts/provision-team.js";

const roster: TeamRoster = {
  teamName: "Synthetic Pilot",
  members: [
    {
      username: "synthetic_manager",
      displayName: "Synthetic Manager",
      role: "manager",
    },
    {
      username: "synthetic_sales",
      displayName: "Synthetic Sales",
      role: "sales",
    },
    {
      username: "synthetic_admin",
      displayName: "Synthetic Admin",
      role: "admin",
    },
  ],
};
const tenantId = "provision_test";
const safeEnv = {
  MIGRATION_DATABASE_URL:
    "postgresql://synthetic:never-used-test-password@127.0.0.1/sales_workbench_test",
  TENANT_ID: tenantId,
};

describe("Explicit team provisioning with isolated synthetic data", () => {
  let db: Database;
  let temporaryRoot: string;
  let privateDirectory: string;
  const output = (name = "credentials.json") => join(privateDirectory, name);
  const run = (body: TeamRoster = roster, name?: string, database = db) =>
    provisionTeam(database, {
      roster: body,
      tenantId,
      credentialsPath: output(name),
    });
  const users = () =>
    db.query<Record<string, any>>("SELECT * FROM crm.users ORDER BY username");
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "sales-provision-test-"));
    privateDirectory = join(temporaryRoot, ".private");
    db = await openDatabase({ source: "demo", demoPath: "memory://" });
    for (const sql of (await readFile("database/001_crm.sql", "utf8"))
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await db.query(sql);
  });
  beforeEach(async () => {
    await rm(privateDirectory, { recursive: true, force: true });
    await mkdir(privateDirectory, { mode: 0o700 });
    await db.query("TRUNCATE crm.tenants CASCADE");
    await db.query(
      "INSERT INTO crm.tenants(id,name) VALUES($1,'Synthetic Company')",
      [tenantId],
    );
  });
  afterAll(async () => {
    await db?.close();
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("creates all roles in one team with independent passwords and an owner-only credentials file", async () => {
    await writeFile(output("roster.json"), JSON.stringify(roster), {
      mode: 0o600,
    });
    const checked = await readTeamRoster(output("roster.json"));
    const result = await run(checked);
    expect(result).toEqual({ created: 3, skipped: 0, teamCreated: true });
    expect((await stat(output())).mode & 0o777).toBe(0o600);
    const credentials = JSON.parse(await readFile(output(), "utf8"));
    expect(credentials.members).toHaveLength(3);
    expect(
      new Set(
        credentials.members.map((member: any) => member.temporaryPassword),
      ).size,
    ).toBe(3);
    const rows = (await users()).rows;
    for (const member of credentials.members) {
      expect(member.temporaryPassword).toHaveLength(32);
      const row = rows.find((user) => user.username === member.username)!;
      expect(row.team_id).toBe(credentials.teamId);
      expect(row.enabled).toBe(true);
      expect(row.must_change_password).toBe(true);
      expect(row.password_hash).not.toBe(member.temporaryPassword);
      expect(
        await verifyPassword(member.temporaryPassword, row.password_hash),
      ).toBe(true);
    }
    const audit = (
      await db.query<{ request_id: string; changes: unknown }>(
        "SELECT request_id,changes FROM crm.audit_logs",
      )
    ).rows;
    expect(audit).toHaveLength(4);
    expect(
      audit.every((row) => row.request_id === credentials.operationId),
    ).toBe(true);
    for (const member of credentials.members)
      expect(JSON.stringify(audit)).not.toContain(member.temporaryPassword);
  });

  it("repeats without resetting an account even after its owner changed the password", async () => {
    await run();
    await db.query(
      "UPDATE crm.users SET password_hash='changed-by-owner', must_change_password=false, session_version=2, version=2",
    );
    const before = (await users()).rows;
    const repeated = {
      ...roster,
      members: roster.members.map((member) => ({
        ...member,
        username: member.username.toUpperCase(),
      })),
    };
    expect(await run(repeated, "repeat.json")).toEqual({
      created: 0,
      skipped: 3,
      teamCreated: false,
    });
    expect((await users()).rows).toEqual(before);
    expect((await db.query("SELECT * FROM crm.teams")).rows).toHaveLength(1);
    expect((await db.query("SELECT * FROM crm.audit_logs")).rows).toHaveLength(
      4,
    );
    expect(
      JSON.parse(await readFile(output("repeat.json"), "utf8")).members,
    ).toEqual([]);
    expect(JSON.parse(await readFile(output(), "utf8")).members).toHaveLength(
      3,
    );
  });

  it.each(["displayName", "role", "team", "disabled"])(
    "refuses a conflicting existing %s and rolls back every earlier insertion",
    async (mismatch) => {
      await run();
      const before = (await users()).rows;
      const conflict = { ...roster.members[0] };
      if (mismatch === "displayName")
        conflict.displayName = "Different Synthetic Name";
      if (mismatch === "role") conflict.role = "sales";
      if (mismatch === "disabled")
        await db.query("UPDATE crm.users SET enabled=false WHERE username=$1", [
          conflict.username,
        ]);
      const beforeAttempt = (await users()).rows;
      await expect(
        run(
          {
            teamName:
              mismatch === "team" ? "Other Synthetic Team" : roster.teamName,
            members: [
              {
                username: "new_before_conflict",
                displayName: "New Synthetic User",
                role: "sales",
              },
              conflict,
            ],
          },
          "conflict.json",
        ),
      ).rejects.toMatchObject({ code: "EXISTING_USER_CONFLICT" });
      expect((await users()).rows).toEqual(beforeAttempt);
      expect((await db.query("SELECT * FROM crm.teams")).rows).toHaveLength(1);
      expect(
        (await db.query("SELECT * FROM crm.audit_logs")).rows,
      ).toHaveLength(4);
      await expect(stat(output("conflict.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(before).toHaveLength(3);
    },
  );

  it("refuses an existing output instead of overwriting it or creating any accounts", async () => {
    await writeFile(output(), "existing private document", { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ code: "OUTPUT_NOT_NEW" });
    expect(await readFile(output(), "utf8")).toBe("existing private document");
    expect((await users()).rows).toEqual([]);
    expect((await db.query("SELECT * FROM crm.teams")).rows).toEqual([]);
  });

  it("refuses insecure input files, symlinks and non-private directories", async () => {
    await writeFile(output("roster.json"), JSON.stringify(roster), {
      mode: 0o644,
    });
    // Construct the insecure fixture even under an operator's restrictive umask.
    await chmod(output("roster.json"), 0o644);
    await expect(readTeamRoster(output("roster.json"))).rejects.toMatchObject({
      code: "UNSAFE_ROSTER_FILE",
    });
    await chmod(output("roster.json"), 0o600);
    await symlink(output("roster.json"), output("alias.json"));
    await expect(readTeamRoster(output("alias.json"))).rejects.toMatchObject({
      code: "INVALID_ROSTER",
    });
    await chmod(privateDirectory, 0o755);
    await expect(readTeamRoster(output("roster.json"))).rejects.toMatchObject({
      code: "UNSAFE_PRIVATE_DIRECTORY",
    });
    await expect(run()).rejects.toMatchObject({
      code: "UNSAFE_PRIVATE_DIRECTORY",
    });
    expect((await users()).rows).toEqual([]);
  });

  it("refuses paths that the release package could include", async () => {
    await expect(
      readTeamRoster(resolve("scripts/roster.json")),
    ).rejects.toMatchObject({ code: "UNSAFE_PRIVATE_PATH" });
    await expect(
      provisionTeam(db, {
        roster,
        tenantId,
        credentialsPath: resolve("scripts/credentials.json"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PRIVATE_PATH" });
    expect((await users()).rows).toEqual([]);
  });

  it("refuses repeated usernames, malformed fields and a missing company", async () => {
    const duplicate = {
      ...roster,
      members: [
        roster.members[0],
        {
          ...roster.members[0],
          username: roster.members[0].username.toUpperCase(),
        },
      ],
    };
    await expect(run(duplicate)).rejects.toMatchObject({
      code: "DUPLICATE_USERNAME",
    });
    await writeFile(
      output("invalid.json"),
      JSON.stringify({ ...roster, password: "not-accepted" }),
      { mode: 0o600 },
    );
    await expect(readTeamRoster(output("invalid.json"))).rejects.toMatchObject({
      code: "INVALID_ROSTER",
    });
    await expect(
      provisionTeam(db, {
        roster,
        tenantId: "missing",
        credentialsPath: output(),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TENANT" });
    expect((await users()).rows).toEqual([]);
    await expect(stat(output())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains recoverable credentials if the commit succeeds but its response is lost", async () => {
    const lostCommit: Database = {
      ...db,
      async transaction(fn, options) {
        await db.transaction(fn, options);
        throw new Error("Simulated lost COMMIT response");
      },
    };
    await expect(run(roster, undefined, lostCommit)).rejects.toMatchObject({
      code: "COMMIT_UNCERTAIN",
    });
    const saved = JSON.parse(await readFile(output(), "utf8"));
    const rows = (await users()).rows;
    expect(rows).toHaveLength(3);
    expect((await stat(output())).mode & 0o777).toBe(0o600);
    for (const member of saved.members)
      expect(
        await verifyPassword(
          member.temporaryPassword,
          rows.find((row) => row.username === member.username)!.password_hash,
        ),
      ).toBe(true);
    const matched = (
      await db.query("SELECT * FROM crm.audit_logs WHERE request_id=$1", [
        saved.operationId,
      ])
    ).rows;
    expect(matched).toHaveLength(4);
  });

  it("requires an explicitly confirmed dedicated database and an explicit company", () => {
    const args = [
      "--members",
      output("roster.json"),
      "--credentials-out",
      output(),
      "--confirm-target=sales_workbench_test",
    ];
    expect(parseProvisionOptions(args, safeEnv).target).toBe(
      "sales_workbench_test",
    );
    expect(() =>
      parseProvisionOptions(args, {
        ...safeEnv,
        MIGRATION_DATABASE_URL: safeEnv.MIGRATION_DATABASE_URL.replace(
          "sales_workbench_test",
          "transport_live",
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_DATABASE" }));
    expect(() => parseProvisionOptions(args.slice(0, -1), safeEnv)).toThrow(
      expect.objectContaining({ code: "TARGET_CONFIRMATION_REQUIRED" }),
    );
    expect(() =>
      parseProvisionOptions(args, { ...safeEnv, TENANT_ID: undefined }),
    ).toThrow(expect.objectContaining({ code: "TENANT_REQUIRED" }));
    expect(() =>
      parseProvisionOptions([...args, "--password", "not-accepted"], safeEnv),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
  });

  it("does not print connection secrets or roster details when the CLI refuses a target", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/provision-team.ts",
        "--members",
        output("roster.json"),
        "--credentials-out",
        output(),
        "--confirm-target=transport_live",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...safeEnv,
          MIGRATION_DATABASE_URL:
            "postgresql://secret-test-user:do-not-print-this-password@127.0.0.1/transport_live",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INVALID_DATABASE");
    expect(result.stderr).not.toContain("secret-test-user");
    expect(result.stderr).not.toContain("do-not-print-this-password");
    expect(result.stderr).not.toContain(roster.teamName);
  });
});
