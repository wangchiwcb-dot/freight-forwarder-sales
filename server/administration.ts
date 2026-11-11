import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Database, Queryable } from "./db.js";
import { hashPassword, publicUser } from "./auth.js";
import {
  actorLock,
  audit,
  dto,
  fail,
  paginated,
  parse,
  requireAdmin,
  update,
  version,
  type Row,
} from "./core.js";
import { expectedVersion, reason } from "./validation.js";

type Send = (request: FastifyRequest, data: unknown, meta?: Row) => unknown;
const roles = ["sales", "manager", "admin"] as const;
const userFields = {
  displayName: z.string().trim().min(1).max(100),
  role: z.enum(roles),
  teamId: z.uuid().nullable(),
  enabled: z.boolean(),
};
const idOf = (request: FastifyRequest) =>
  parse(z.uuid(), (request.params as Row).id);
const orgLock = async (tx: Queryable, tenant: string) => {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('sales_workbench:org:' || $1,0))",
    [tenant],
  );
};
async function teamValid(
  tx: Queryable,
  user: Row,
  teamId: string | null,
  role: string,
  enabled: boolean,
) {
  if (!teamId) {
    if (role !== "admin") fail(422, "TEAM_REQUIRED", "销售和主管必须分配团队");
    return;
  }
  const team = (
    await tx.query<Row>(
      "SELECT * FROM crm.teams WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [user.tenant_id, teamId],
    )
  ).rows[0];
  if (!team || (enabled && !team.enabled))
    fail(422, "TEAM_DISABLED", "请选择启用的团队");
}
function teamDto(row: Row) {
  const { tenant_id: _tenant, ...rest } = row;
  return dto(rest);
}
export async function registerAdministration(
  app: FastifyInstance,
  db: Database,
  config: Config,
  send: Send,
) {
  app.get("/api/v1/assignees", async (request) => {
    const user = request.user!;
    const values: unknown[] = [user.tenant_id];
    let where = "tenant_id=$1 AND enabled=true";
    if (user.role === "sales") {
      values.push(user.id);
      where += " AND id=$2";
    } else if (user.role === "manager") {
      values.push(user.team_id);
      where += " AND team_id=$2";
    }
    const rows = (
      await db.query<Row>(
        `SELECT id,display_name,team_id FROM crm.users WHERE ${where} ORDER BY display_name,id LIMIT 100`,
        values,
      )
    ).rows;
    return send(request, rows.map(dto));
  });
  app.get("/api/v1/users", async (request) => {
    requireAdmin(request.user!);
    const q = request.query as Row;
    const values: unknown[] = [request.user!.tenant_id];
    let where = "u.tenant_id=$1";
    if (q.keyword) {
      values.push(
        "%" +
          parse(z.string().max(100), q.keyword).replace(/[\\%_]/g, "\\$&") +
          "%",
      );
      where += " AND (u.username ILIKE $2 OR u.display_name ILIKE $2)";
    }
    const list = await paginated(
      db,
      "u.*,t.name AS team_name",
      "FROM crm.users u LEFT JOIN crm.teams t ON (u.tenant_id,u.team_id)=(t.tenant_id,t.id) WHERE " +
        where,
      values,
      "u.created_at DESC,u.id DESC",
      q,
    );
    return send(
      request,
      list.rows.map((row) => publicUser(row, config)),
      list.meta,
    );
  });
  app.get("/api/v1/users/:id", async (request) => {
    requireAdmin(request.user!);
    const row = (
      await db.query<Row>(
        "SELECT u.*,t.name AS team_name FROM crm.users u LEFT JOIN crm.teams t ON (u.tenant_id,u.team_id)=(t.tenant_id,t.id) WHERE u.tenant_id=$1 AND u.id=$2",
        [request.user!.tenant_id, idOf(request)],
      )
    ).rows[0];
    if (!row) fail(404, "NOT_FOUND", "员工不存在");
    return send(request, publicUser(row, config));
  });
  app.get("/api/v1/users/:id/impact", async (request) => {
    requireAdmin(request.user!);
    const id = idOf(request);
    const user = (
      await db.query<Row>(
        "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2",
        [request.user!.tenant_id, id],
      )
    ).rows[0];
    if (!user) fail(404, "NOT_FOUND", "员工不存在");
    const c = (
      await db.query<Row>(
        "SELECT count(*) FILTER(WHERE archived_at IS NULL)::int AS active,count(*) FILTER(WHERE archived_at IS NOT NULL)::int AS archived FROM crm.customers WHERE tenant_id=$1 AND owner_id=$2",
        [user.tenant_id, user.id],
      )
    ).rows[0];
    const a = (
      await db.query<Row>(
        "SELECT count(*)::int AS n FROM crm.activities WHERE tenant_id=$1 AND owner_id=$2",
        [user.tenant_id, user.id],
      )
    ).rows[0];
    return send(request, {
      userId: user.id,
      version: user.version,
      teamId: user.team_id,
      activeCustomerCount: c.active,
      archivedCustomerCount: c.archived,
      activityCount: a.n,
    });
  });
  app.post("/api/v1/users", async (request, reply) => {
    requireAdmin(request.user!);
    const input = parse(
      z
        .object({
          username: z.string().trim().min(1).max(100),
          displayName: userFields.displayName,
          role: userFields.role,
          teamId: userFields.teamId.optional(),
        })
        .strict(),
      request.body,
    );
    const temporaryPassword = randomBytes(18).toString("base64url");
    const hashed = await hashPassword(temporaryPassword);
    const result = await db.transaction(async (tx) => {
      await orgLock(tx, request.user!.tenant_id);
      const actor = await actorLock(tx, request.user!);
      requireAdmin(actor);
      await teamValid(tx, actor, input.teamId ?? null, input.role, true);
      const row = (
        await tx.query<Row>(
          "INSERT INTO crm.users(tenant_id,username,display_name,role,team_id,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            actor.tenant_id,
            input.username,
            input.displayName,
            input.role,
            input.teamId ?? null,
            hashed,
          ],
        )
      ).rows[0];
      const user = publicUser(row, config);
      await audit(tx, actor, request, "user", row.id, "create", {
        after: user,
      });
      return { user, temporaryPassword };
    });
    reply.code(201);
    return send(request, result);
  });
  app.patch("/api/v1/users/:id", async (request) => {
    requireAdmin(request.user!);
    const input = parse(
      z
        .object({
          expectedVersion,
          changes: z
            .object(userFields)
            .partial()
            .strict()
            .refine((x) => Object.keys(x).length > 0),
          reason,
        })
        .strict(),
      request.body,
    );
    return send(
      request,
      await db.transaction(async (tx) => {
        await orgLock(tx, request.user!.tenant_id);
        const actor = await actorLock(tx, request.user!);
        requireAdmin(actor);
        const row = (
          await tx.query<Row>(
            "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [actor.tenant_id, idOf(request)],
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND", "员工不存在");
        version(row, input.expectedVersion);
        const merged = { ...dto(row), ...input.changes };
        await teamValid(
          tx,
          actor,
          merged.teamId === undefined ? row.team_id : merged.teamId,
          merged.role ?? row.role,
          merged.enabled ?? row.enabled,
        );
        if (
          row.enabled &&
          row.role === "admin" &&
          (!merged.enabled || merged.role !== "admin")
        ) {
          const n = Number(
            (
              await tx.query<Row>(
                "SELECT count(*) AS n FROM crm.users WHERE tenant_id=$1 AND enabled=true AND role='admin'",
                [actor.tenant_id],
              )
            ).rows[0].n,
          );
          if (n <= 1) fail(422, "LAST_ADMIN", "必须保留至少一位启用的管理员");
        }
        const revoke =
          merged.role !== row.role ||
          merged.teamId !== row.team_id ||
          merged.enabled !== row.enabled;
        const changes: Row = { ...input.changes };
        if (revoke) changes.sessionVersion = row.session_version + 1;
        const after = await update(
          tx,
          "users",
          row.id,
          actor.tenant_id,
          changes,
        );
        if (revoke)
          await tx.query(
            "UPDATE crm.sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
            [actor.tenant_id, row.id],
          );
        await audit(
          tx,
          actor,
          request,
          "user",
          row.id,
          "update",
          { before: publicUser(row, config), after: publicUser(after, config) },
          input.reason,
        );
        return publicUser(after, config);
      }),
    );
  });
  app.post("/api/v1/users/:id/reset-password", async (request) => {
    requireAdmin(request.user!);
    const input = parse(
      z.object({ expectedVersion, reason }).strict(),
      request.body,
    );
    const temporaryPassword = randomBytes(18).toString("base64url");
    const hash = await hashPassword(temporaryPassword);
    return send(
      request,
      await db.transaction(async (tx) => {
        await orgLock(tx, request.user!.tenant_id);
        const actor = await actorLock(tx, request.user!);
        requireAdmin(actor);
        const row = (
          await tx.query<Row>(
            "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [actor.tenant_id, idOf(request)],
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND", "员工不存在");
        version(row, input.expectedVersion);
        await update(tx, "users", row.id, actor.tenant_id, {
          passwordHash: hash,
          mustChangePassword: true,
          sessionVersion: row.session_version + 1,
        });
        await tx.query(
          "UPDATE crm.sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [actor.tenant_id, row.id],
        );
        await audit(
          tx,
          actor,
          request,
          "user",
          row.id,
          "reset_password",
          {},
          input.reason,
        );
        return { temporaryPassword };
      }),
    );
  });
  app.get("/api/v1/teams", async (request) => {
    requireAdmin(request.user!);
    const list = await paginated(
      db,
      "*",
      "FROM crm.teams WHERE tenant_id=$1",
      [request.user!.tenant_id],
      "name,id",
      request.query,
    );
    return send(request, list.rows.map(teamDto), list.meta);
  });
  app.get("/api/v1/teams/:id", async (request) => {
    requireAdmin(request.user!);
    const row = (
      await db.query<Row>(
        "SELECT * FROM crm.teams WHERE tenant_id=$1 AND id=$2",
        [request.user!.tenant_id, idOf(request)],
      )
    ).rows[0];
    if (!row) fail(404, "NOT_FOUND", "团队不存在");
    return send(request, teamDto(row));
  });
  app.post("/api/v1/teams", async (request, reply) => {
    requireAdmin(request.user!);
    const input = parse(
      z.object({ name: z.string().trim().min(1).max(100) }).strict(),
      request.body,
    );
    const data = await db.transaction(async (tx) => {
      await orgLock(tx, request.user!.tenant_id);
      const actor = await actorLock(tx, request.user!);
      requireAdmin(actor);
      const row = (
        await tx.query<Row>(
          "INSERT INTO crm.teams(tenant_id,name) VALUES($1,$2) RETURNING *",
          [actor.tenant_id, input.name],
        )
      ).rows[0];
      await audit(tx, actor, request, "team", row.id, "create", {
        after: teamDto(row),
      });
      return teamDto(row);
    });
    reply.code(201);
    return send(request, data);
  });
  app.patch("/api/v1/teams/:id", async (request) => {
    requireAdmin(request.user!);
    const input = parse(
      z
        .object({
          expectedVersion,
          changes: z
            .object({
              name: z.string().trim().min(1).max(100).optional(),
              enabled: z.boolean().optional(),
            })
            .strict()
            .refine((x) => Object.keys(x).length > 0),
          reason,
        })
        .strict(),
      request.body,
    );
    return send(
      request,
      await db.transaction(async (tx) => {
        await orgLock(tx, request.user!.tenant_id);
        const actor = await actorLock(tx, request.user!);
        requireAdmin(actor);
        const row = (
          await tx.query<Row>(
            "SELECT * FROM crm.teams WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [actor.tenant_id, idOf(request)],
          )
        ).rows[0];
        if (!row) fail(404, "NOT_FOUND", "团队不存在");
        version(row, input.expectedVersion);
        if (input.changes.enabled === false) {
          const n = Number(
            (
              await tx.query<Row>(
                "SELECT count(*) AS n FROM crm.users WHERE tenant_id=$1 AND team_id=$2 AND enabled=true",
                [actor.tenant_id, row.id],
              )
            ).rows[0].n,
          );
          if (n) fail(422, "TEAM_HAS_MEMBERS", "请先调整团队内的启用员工");
        }
        const after = await update(
          tx,
          "teams",
          row.id,
          actor.tenant_id,
          input.changes,
        );
        await audit(
          tx,
          actor,
          request,
          "team",
          row.id,
          "update",
          { before: teamDto(row), after: teamDto(after) },
          input.reason,
        );
        return teamDto(after);
      }),
    );
  });
  app.get("/api/v1/audit-logs", async (request) => {
    requireAdmin(request.user!);
    const q = request.query as Row;
    const params: unknown[] = [request.user!.tenant_id];
    const parts = ["a.tenant_id=$1"];
    const add = (column: string, value: unknown, op = "=") => {
      params.push(value);
      parts.push(`${column}${op}$${params.length}`);
    };
    if (q.entityType)
      add("a.entity_type", parse(z.string().max(50), q.entityType));
    if (q.action) add("a.action", parse(z.string().max(100), q.action));
    if (q.actorId) add("a.actor_id", parse(z.uuid(), q.actorId));
    if (q.entityId) add("a.entity_id", parse(z.uuid(), q.entityId));
    if (q.dateFrom)
      add(
        "a.created_at",
        parse(z.iso.datetime({ offset: true }), q.dateFrom),
        ">=",
      );
    if (q.dateTo)
      add(
        "a.created_at",
        parse(z.iso.datetime({ offset: true }), q.dateTo),
        "<",
      );
    const list = await paginated(
      db,
      "a.*,u.display_name AS actor_name",
      "FROM crm.audit_logs a LEFT JOIN crm.users u ON (a.tenant_id,a.actor_id)=(u.tenant_id,u.id) WHERE " +
        parts.join(" AND "),
      params,
      "a.created_at DESC,a.id DESC",
      q,
    );
    return send(request, list.rows.map(dto), list.meta);
  });
}
