import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { hashPassword } from "../server/auth.js";
import { openDatabase, type Database, type Queryable } from "../server/db.js";

const rosterSchema = z
  .object({
    teamName: z.string().trim().min(1).max(100),
    members: z
      .array(
        z
          .object({
            username: z.string().trim().min(1).max(100),
            displayName: z.string().trim().min(1).max(100),
            role: z.enum(["sales", "manager", "admin"]),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type TeamRoster = z.infer<typeof rosterSchema>;

export class ProvisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}
function refuse(code: string, message: string): never {
  throw new ProvisionError(code, message);
}
const ownerId = () => process.geteuid?.();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// The source lives in scripts/; the production entry lives in dist/api/scripts/.
const installationRoot = resolve(
  moduleDirectory,
  basename(dirname(moduleDirectory)) === "api" ? "../../.." : "..",
);

export function parseProvisionOptions(args: string[], env: NodeJS.ProcessEnv) {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        members: { type: "string" },
        "credentials-out": { type: "string" },
        "confirm-target": { type: "string" },
      },
    }).values;
  } catch {
    return refuse(
      "INVALID_ARGUMENTS",
      "Use --members, --credentials-out and --confirm-target; never pass credentials as arguments.",
    );
  }
  const databaseUrl = env.MIGRATION_DATABASE_URL;
  let target: string;
  try {
    const url = new URL(databaseUrl ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    target = url.pathname.slice(1);
  } catch {
    return refuse(
      "INVALID_DATABASE",
      "A protected MIGRATION_DATABASE_URL is required.",
    );
  }
  if (!/^sales_workbench(?:_[a-z0-9_]+)?$/.test(target!))
    refuse(
      "INVALID_DATABASE",
      "Only a dedicated sales_workbench database is allowed.",
    );
  if (values["confirm-target"] !== target!)
    refuse(
      "TARGET_CONFIRMATION_REQUIRED",
      "The confirmed database must match the protected migration connection.",
    );
  if (!env.TENANT_ID?.trim() || env.TENANT_ID.length > 100)
    refuse(
      "TENANT_REQUIRED",
      "Provide the existing company TENANT_ID explicitly.",
    );
  if (!values.members || !values["credentials-out"])
    refuse(
      "INVALID_ARGUMENTS",
      "Both a private roster file and a new private credentials file are required.",
    );
  return {
    databaseUrl: databaseUrl!,
    target: target!,
    tenantId: env.TENANT_ID!,
    membersPath: values.members!,
    credentialsPath: values["credentials-out"]!,
  };
}

async function privatePath(path: string): Promise<string> {
  const requested = resolve(path);
  const parent = await realpath(dirname(requested));
  const canonical = resolve(parent, basename(requested));
  const root = await realpath(installationRoot);
  const inside = relative(root, canonical);
  if (
    inside !== ".." &&
    !inside.startsWith(".." + sep) &&
    !isAbsolute(inside) &&
    inside.split(sep)[0] !== ".private"
  )
    refuse(
      "UNSAFE_PRIVATE_PATH",
      "Inside the release or repository, private files must stay in its top-level .private directory.",
    );
  let current = parent;
  let foundPrivateDirectory = false;
  while (true) {
    const info = await stat(current);
    if (
      !info.isDirectory() ||
      (info.mode & 0o777) !== 0o700 ||
      (ownerId() !== undefined && info.uid !== ownerId())
    )
      refuse(
        "UNSAFE_PRIVATE_DIRECTORY",
        "The .private directory and its children must be owner-only directories (0700).",
      );
    if (basename(current) === ".private") {
      foundPrivateDirectory = true;
      break;
    }
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  if (!foundPrivateDirectory)
    refuse(
      "UNSAFE_PRIVATE_PATH",
      "Use an owner-only .private directory, either outside the release or at its top level.",
    );
  return canonical;
}

export async function readTeamRoster(path: string): Promise<TeamRoster> {
  const canonical = await privatePath(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      (ownerId() !== undefined && info.uid !== ownerId()) ||
      info.size > 262144
    )
      refuse(
        "UNSAFE_ROSTER_FILE",
        "The roster must be a single owner-only regular file (0600), no larger than 256 KiB.",
      );
    const result = rosterSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    if (!result.success)
      refuse(
        "INVALID_ROSTER",
        "The roster must contain a teamName and 1–200 valid members only.",
      );
    const roster = result.data;
    const logins = roster.members.map((member) =>
      member.username.toLowerCase(),
    );
    if (new Set(logins).size !== logins.length)
      refuse(
        "DUPLICATE_USERNAME",
        "The roster contains a repeated login name. No accounts were changed.",
      );
    return roster;
  } catch (error) {
    if (error instanceof ProvisionError) throw error;
    return refuse(
      "INVALID_ROSTER",
      "Cannot read the private roster. Check its JSON, ownership, permissions and file type.",
    );
  } finally {
    await handle?.close();
  }
}

interface ExistingUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  team_id: string | null;
  enabled: boolean;
}
interface CredentialsMember {
  username: string;
  displayName: string;
  role: TeamRoster["members"][number]["role"];
  temporaryPassword: string;
  mustChangePassword: true;
}
async function provisionAudit(
  tx: Queryable,
  tenantId: string,
  operationId: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
) {
  await tx.query(
    "INSERT INTO crm.audit_logs(tenant_id,entity_type,entity_id,action,request_id,changes) VALUES($1,$2,$3,'provision_team',$4,$5::jsonb)",
    [
      tenantId,
      entityType,
      entityId,
      operationId,
      JSON.stringify({ source: "explicit-team-provision", after }),
    ],
  );
}

/** Explicit provisioning only; the CLI verifies the actual database before calling. */
export async function provisionTeam(
  db: Database,
  options: {
    roster: TeamRoster;
    tenantId: string;
    credentialsPath: string;
  },
) {
  // Validate again for callers other than the private-file CLI.
  const checked = rosterSchema.safeParse(options.roster);
  if (!checked.success)
    refuse(
      "INVALID_ROSTER",
      "The roster is invalid. No accounts were changed.",
    );
  const roster = checked.data;
  if (
    new Set(roster.members.map((member) => member.username.toLowerCase()))
      .size !== roster.members.length
  )
    refuse(
      "DUPLICATE_USERNAME",
      "The roster contains a repeated login name. No accounts were changed.",
    );
  const output = await privatePath(options.credentialsPath);
  let handle: FileHandle;
  try {
    handle = await open(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return refuse(
      "OUTPUT_NOT_NEW",
      "The credentials destination must be a new file in a writable private directory. Existing files are never overwritten.",
    );
  }
  let persisted = false;
  try {
    await handle.chmod(0o600);
    return await db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('sales_workbench:org:' || $1,0))",
        [options.tenantId],
      );
      if (
        !(
          await tx.query("SELECT 1 FROM crm.tenants WHERE id=$1", [
            options.tenantId,
          ])
        ).rows.length
      )
        refuse(
          "UNKNOWN_TENANT",
          "The company does not exist. Bootstrap it separately before provisioning a team.",
        );
      const teams = (
        await tx.query<{ id: string; enabled: boolean }>(
          "SELECT id,enabled FROM crm.teams WHERE tenant_id=$1 AND name=$2 FOR UPDATE",
          [options.tenantId, roster.teamName],
        )
      ).rows;
      if (teams.length > 1)
        refuse(
          "AMBIGUOUS_TEAM",
          "Multiple teams match the roster. Resolve the existing records first.",
        );
      if (teams[0] && !teams[0].enabled)
        refuse(
          "DISABLED_TEAM",
          "The existing team is disabled. It will not be re-enabled by provisioning.",
        );
      const operationId = randomUUID();
      const teamCreated = teams.length === 0;
      const teamId =
        teams[0]?.id ??
        (
          await tx.query<{ id: string }>(
            "INSERT INTO crm.teams(tenant_id,name) VALUES($1,$2) RETURNING id",
            [options.tenantId, roster.teamName],
          )
        ).rows[0].id;
      if (teamCreated)
        await provisionAudit(
          tx,
          options.tenantId,
          operationId,
          "team",
          teamId,
          { name: roster.teamName, enabled: true },
        );
      const credentials: CredentialsMember[] = [];
      let skipped = 0;
      for (const member of roster.members) {
        const previous = (
          await tx.query<ExistingUser>(
            "SELECT id,username,display_name,role,team_id,enabled FROM crm.users WHERE tenant_id=$1 AND lower(username)=lower($2) FOR UPDATE",
            [options.tenantId, member.username],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.display_name !== member.displayName ||
            previous.role !== member.role ||
            previous.team_id !== teamId ||
            !previous.enabled
          )
            refuse(
              "EXISTING_USER_CONFLICT",
              "An existing login has different profile, role, team or enabled state. The entire provisioning transaction was refused; no existing account is reset.",
            );
          skipped++;
          continue;
        }
        const temporaryPassword = randomBytes(24).toString("base64url");
        const row = (
          await tx.query<{ id: string }>(
            "INSERT INTO crm.users(tenant_id,team_id,username,display_name,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id",
            [
              options.tenantId,
              teamId,
              member.username,
              member.displayName,
              member.role,
              await hashPassword(temporaryPassword),
            ],
          )
        ).rows[0];
        await provisionAudit(
          tx,
          options.tenantId,
          operationId,
          "user",
          row.id,
          {
            username: member.username,
            displayName: member.displayName,
            role: member.role,
            teamId,
            enabled: true,
            mustChangePassword: true,
          },
        );
        credentials.push({
          ...member,
          temporaryPassword,
          mustChangePassword: true,
        });
      }
      // Persist and sync BEFORE commit so a committed account never loses its one-time password.
      // A lost COMMIT response is ambiguous: retain this file and verify operationId in audit_logs.
      await handle.writeFile(
        JSON.stringify(
          {
            operationId,
            createdAt: new Date().toISOString(),
            tenantId: options.tenantId,
            teamName: roster.teamName,
            teamId,
            notice:
              "Distribute only after successful script completion. If the result was uncertain, verify this operationId in crm.audit_logs first. Existing accounts are skipped and their passwords are never exported.",
            members: credentials,
            skippedCount: skipped,
          },
          null,
          2,
        ) + "\n",
      );
      await handle.sync();
      const directory = await open(dirname(output), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      persisted = true;
      return { created: credentials.length, skipped, teamCreated };
    });
  } catch (error) {
    if (persisted)
      return refuse(
        "COMMIT_UNCERTAIN",
        "The transaction outcome requires verification. The private credentials file was retained; check its operationId in the database before distributing it. Never reset existing passwords by rerunning.",
      );
    await unlink(output).catch(() => {});
    if (error instanceof ProvisionError) throw error;
    return refuse(
      "PROVISION_FAILED",
      "Provisioning failed before commit. No credentials are printed; inspect database availability and permissions before retrying.",
    );
  } finally {
    await handle.close();
  }
}

export async function runProvisionTeam(args: string[], env: NodeJS.ProcessEnv) {
  const options = parseProvisionOptions(args, env);
  const roster = await readTeamRoster(options.membersPath);
  const db = await openDatabase({
    source: "postgres",
    databaseUrl: options.databaseUrl,
  });
  try {
    const actual = (
      await db.query<{ name: string }>("SELECT current_database() AS name")
    ).rows[0]?.name;
    if (actual !== options.target)
      refuse(
        "DATABASE_MISMATCH",
        "The actual database does not match the explicitly confirmed target.",
      );
    const versions = (
      await db.query<{ version: number }>(
        "SELECT version FROM crm.migrations ORDER BY version",
      )
    ).rows;
    if (versions.length !== 1 || versions[0].version !== 1)
      refuse(
        "SCHEMA_MISMATCH",
        "Provisioning requires the registered sales schema version 1.",
      );
    return await provisionTeam(db, {
      roster,
      tenantId: options.tenantId,
      credentialsPath: options.credentialsPath,
    });
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void runProvisionTeam(process.argv.slice(2), process.env)
    .then((result) => {
      console.log(
        `Team provisioning completed: ${result.created} created, ${result.skipped} unchanged. Credentials were written to the specified private file.`,
      );
    })
    .catch((error) => {
      console.error(
        error instanceof ProvisionError
          ? `${error.code}: ${error.message}`
          : "PROVISION_FAILED: Provisioning failed. No roster, password or connection details are printed.",
      );
      process.exitCode = 1;
    });
}
