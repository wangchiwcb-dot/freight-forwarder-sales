import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { Queryable } from "./db.js";

export type Row = Record<string, any>;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "请检查输入内容",
      result.error.flatten().fieldErrors as Record<string, string[]>,
    );
  return result.data;
}
export function dto(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}
export function version(row: Row, expected: number) {
  if (row.version !== expected)
    fail(409, "VERSION_CONFLICT", "记录已被更新，请刷新后重试");
}
export function requireAdmin(user: Row) {
  if (user.role !== "admin") fail(403, "FORBIDDEN", "此操作需要管理员权限");
}
export function requireManager(user: Row) {
  if (!["admin", "manager"].includes(user.role))
    fail(403, "FORBIDDEN", "此操作需要主管或管理员权限");
}
export function assertVisible(user: Row, row: Row) {
  if (
    row.tenant_id !== user.tenant_id ||
    (user.role === "sales" && row.owner_id !== user.id) ||
    (user.role === "manager" && row.owner_team_id !== user.team_id)
  )
    fail(404, "NOT_FOUND", "记录不存在或无法访问");
}
export async function customer(
  tx: Queryable,
  user: Row,
  id: string,
  lock = false,
) {
  const row = (
    await tx.query<Row>(
      `SELECT c.*,u.display_name AS owner_name,u.team_id AS owner_team_id,u.enabled AS owner_enabled FROM crm.customers c JOIN crm.users u ON (u.tenant_id,u.id)=(c.tenant_id,c.owner_id) WHERE c.tenant_id=$1 AND c.id=$2 ${lock ? "FOR UPDATE OF c FOR SHARE OF u" : ""}`,
      [user.tenant_id, id],
    )
  ).rows[0];
  if (!row) fail(404, "NOT_FOUND", "客户不存在或无法访问");
  assertVisible(user, row);
  return row;
}
export async function activity(
  tx: Queryable,
  user: Row,
  id: string,
  lock = false,
) {
  const row = (
    await tx.query<Row>(
      `SELECT a.*,u.display_name AS owner_name,u.team_id AS owner_team_id FROM crm.activities a JOIN crm.users u ON (u.tenant_id,u.id)=(a.tenant_id,a.owner_id) WHERE a.tenant_id=$1 AND a.id=$2 ${lock ? "FOR UPDATE OF a FOR SHARE OF u" : ""}`,
      [user.tenant_id, id],
    )
  ).rows[0];
  if (!row) fail(404, "NOT_FOUND", "接触记录不存在或无法访问");
  assertVisible(user, row);
  return row;
}
export function customerDto(row: Row) {
  const {
    owner_team_id: _team,
    owner_enabled: _enabled,
    tenant_id: _tenant,
    ...rest
  } = row;
  return dto(rest);
}
export async function activityDto(tx: Queryable, user: Row, row: Row) {
  const { owner_team_id: _team, tenant_id: _tenant, ...rest } = row;
  let visible = false;
  if (row.converted_customer_id) {
    try {
      await customer(tx, user, row.converted_customer_id);
      visible = true;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  return {
    ...dto(rest),
    converted: Boolean(row.converted_customer_id),
    convertedCustomerId: visible ? row.converted_customer_id : null,
    customerLinkVisible: visible,
  };
}
export async function actorLock(tx: Queryable, user: Row) {
  const current = (
    await tx.query<Row>(
      "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [user.tenant_id, user.id],
    )
  ).rows[0];
  if (!current?.enabled || current.session_version !== user.session_version)
    fail(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
  if (current.must_change_password)
    fail(403, "PASSWORD_CHANGE_REQUIRED", "请先修改初始密码");
  return current;
}
export async function assignee(tx: Queryable, user: Row, id: string) {
  const row = (
    await tx.query<Row>(
      "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [user.tenant_id, id],
    )
  ).rows[0];
  if (
    !row ||
    (user.role === "sales" && row.id !== user.id) ||
    (user.role === "manager" && row.team_id !== user.team_id)
  )
    fail(404, "NOT_FOUND", "负责人不存在或不可分配");
  if (!row.enabled)
    fail(422, "OWNER_INACTIVE", "负责人已停用，请选择启用的员工");
  return row;
}
export async function audit(
  tx: Queryable,
  user: Row,
  request: FastifyRequest,
  entity: string,
  id: string | null,
  action: string,
  changes: unknown,
  reason?: string,
) {
  await tx.query(
    "INSERT INTO crm.audit_logs(tenant_id,actor_id,entity_type,entity_id,action,request_id,changes,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      user.tenant_id,
      user.id,
      entity,
      id,
      action,
      request.id,
      JSON.stringify(changes),
      reason ?? null,
    ],
  );
}
export async function update(
  tx: Queryable,
  table: "customers" | "activities" | "users" | "teams",
  id: string,
  tenant: string,
  changes: Row,
) {
  const entries = Object.entries(changes);
  const cols = entries.map(
    ([key], i) =>
      `${key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())}=$${i + 3}`,
  );
  return (
    await tx.query<Row>(
      `UPDATE crm.${table} SET ${cols.join(",")}${cols.length ? "," : ""}version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [tenant, id, ...entries.map(([, v]) => v)],
    )
  ).rows[0];
}
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export async function paginated(
  tx: Queryable,
  select: string,
  fromWhere: string,
  params: unknown[],
  order: string,
  query: unknown,
) {
  const { page, pageSize } = parse(pageSchema, query);
  const count = Number(
    (await tx.query<Row>(`SELECT count(*) AS n ${fromWhere}`, params)).rows[0]
      ?.n ?? 0,
  );
  const rows = (
    await tx.query<Row>(
      `SELECT ${select} ${fromWhere} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    )
  ).rows;
  return { rows, meta: { page, pageSize, total: count } };
}
export async function scopeWhere(
  tx: Queryable,
  user: Row,
  query: Row,
  alias: string,
) {
  const scope = query.scope ?? "mine";
  if (!["mine", "team", "company"].includes(scope))
    fail(422, "VALIDATION_ERROR", "无效的数据范围");
  if (
    (scope === "team" && !["manager", "admin"].includes(user.role)) ||
    (scope === "company" && user.role !== "admin")
  )
    fail(403, "FORBIDDEN", "无权访问此范围");
  const values: unknown[] = [user.tenant_id];
  const parts = [`${alias}.tenant_id=$1`];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    parts.push(sql.replace("?", "$" + values.length));
  };
  if (scope === "mine") add(`${alias}.owner_id=?`, user.id);
  if (scope === "team") {
    if (!user.team_id) fail(403, "FORBIDDEN", "当前账号未分配团队");
    add("u.team_id=?", user.team_id);
  }
  if (query.teamId) {
    if (user.role !== "admin" || scope !== "company")
      fail(403, "FORBIDDEN", "不能更改团队范围");
    const teamId = parse(z.uuid(), query.teamId);
    const team = (
      await tx.query("SELECT id FROM crm.teams WHERE tenant_id=$1 AND id=$2", [
        user.tenant_id,
        teamId,
      ])
    ).rows[0];
    if (!team) fail(422, "VALIDATION_ERROR", "团队不存在");
    add("u.team_id=?", teamId);
  }
  if (query.ownerId) {
    const ownerId = parse(z.uuid(), query.ownerId);
    const owner = (
      await tx.query<Row>(
        "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2",
        [user.tenant_id, ownerId],
      )
    ).rows[0];
    if (
      !owner ||
      (scope === "mine" && ownerId !== user.id) ||
      (scope === "team" && owner.team_id !== user.team_id)
    )
      fail(403, "FORBIDDEN", "无权查看该员工");
    if (query.teamId && owner.team_id !== query.teamId)
      fail(422, "VALIDATION_ERROR", "员工与团队不匹配");
    add(`${alias}.owner_id=?`, ownerId);
  }
  return { parts, values, add, scope };
}
export function shanghaiDay(date = new Date()) {
  return new Date(
    new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) +
      "T00:00:00+08:00",
  );
}
export function reminder(value: string | null | undefined) {
  if (value && new Date(value).getTime() < shanghaiDay().getTime())
    fail(422, "VALIDATION_ERROR", "下次跟进日期不能早于今天");
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function idempotent(
  tx: Queryable,
  user: Row,
  request: FastifyRequest,
  execute: () => Promise<{ data: any; status?: number }>,
) {
  const key = parse(z.uuid(), request.headers["idempotency-key"]);
  const path = new URL(request.url, "http://local").pathname.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (value) => value.toLowerCase(),
  );
  const target = request.method + " " + path;
  const hash = createHash("sha256")
    .update(target + "\n" + canonical(request.body))
    .digest();
  const added = await tx.query(
    "INSERT INTO crm.idempotency_keys(tenant_id,user_id,request_target,key,request_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours') ON CONFLICT DO NOTHING RETURNING key",
    [user.tenant_id, user.id, target, key, hash],
  );
  if (!added.rows.length) {
    const old = (
      await tx.query<Row>(
        "SELECT * FROM crm.idempotency_keys WHERE tenant_id=$1 AND user_id=$2 AND request_target=$3 AND key=$4 FOR UPDATE",
        [user.tenant_id, user.id, target, key],
      )
    ).rows[0];
    if (new Date(old.expires_at).getTime() <= Date.now())
      fail(409, "IDEMPOTENCY_EXPIRED", "请求已过期，请先确认是否已保存");
    if (!Buffer.from(old.request_hash).equals(hash))
      fail(409, "IDEMPOTENCY_CONFLICT", "同一请求标识不能用于不同内容");
    if (old.state !== "completed")
      fail(409, "REQUEST_IN_PROGRESS", "请求仍在处理中，请稍后重试");
    const data = old.response_body;
    // Re-check every referenced business entity before replaying a response after transfers.
    if (path.includes("/customers/") || path === "/api/v1/customers") {
      const id = data.customer?.id ?? data.id;
      if (id) await customer(tx, user, id);
    }
    if (path.includes("/activities")) {
      const a = data.activity ?? data;
      if (a.id) await activity(tx, user, a.id);
      if (data.customer?.id) await customer(tx, user, data.customer.id);
    }
    return { data, status: old.response_status };
  }
  const result = await execute();
  await tx.query(
    "UPDATE crm.idempotency_keys SET state='completed',response_status=$5,response_body=$6 WHERE tenant_id=$1 AND user_id=$2 AND request_target=$3 AND key=$4",
    [
      user.tenant_id,
      user.id,
      target,
      key,
      result.status ?? 201,
      JSON.stringify(result.data),
    ],
  );
  return { data: result.data, status: result.status ?? 201 };
}
