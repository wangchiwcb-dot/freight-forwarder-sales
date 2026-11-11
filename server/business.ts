import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database, Queryable } from "./db.js";
import {
  actorLock,
  activity,
  activityDto,
  assignee,
  audit,
  customer,
  customerDto,
  dto,
  fail,
  idempotent,
  paginated,
  parse,
  reminder,
  requireAdmin,
  requireManager,
  scopeWhere,
  shanghaiDay,
  update,
  version,
  type Row,
} from "./core.js";
import {
  activityCreate,
  convert,
  customerCreate,
  customerPatch,
  deriveJudge,
  expectedVersion,
  followUp,
  phone,
  reason,
  results,
  sources,
  statuses,
} from "./validation.js";
type Send = (request: FastifyRequest, data: unknown, meta?: Row) => unknown;
const idOf = (request: FastifyRequest) =>
  parse(z.uuid(), (request.params as Row).id);
const queryOf = (request: FastifyRequest) => request.query as Row;
const customerFrom =
  "FROM crm.customers c JOIN crm.users u ON (c.tenant_id,c.owner_id)=(u.tenant_id,u.id)";
const activityFrom =
  "FROM crm.activities a JOIN crm.users u ON (a.tenant_id,a.owner_id)=(u.tenant_id,u.id)";
const customerSelect = "c.*,u.display_name AS owner_name";
const activitySelect = "a.*,u.display_name AS owner_name";
function active(row: Row) {
  if (row.archived_at) fail(409, "CUSTOMER_ARCHIVED", "客户已归档，请先恢复");
}
export async function insertCustomer(
  tx: Queryable,
  user: Row,
  input: Row,
  ownerId: string,
) {
  const payload = parse(customerCreate, input);
  const fields: Row = {
    contact: "",
    altPhone: "",
    wechat: "",
    email: "",
    address: "",
    needs: "",
    note: "",
    highIntent: false,
    ...payload,
  };
  const keys = Object.keys(fields);
  const result = await tx.query<Row>(
    `INSERT INTO crm.customers(tenant_id,owner_id,created_by,${keys.map((k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())).join(",")}) VALUES($1,$2,$3,${keys.map((_, i) => "$" + (i + 4)).join(",")}) RETURNING *`,
    [user.tenant_id, ownerId, user.id, ...Object.values(fields)],
  );
  return result.rows[0];
}
async function transition(
  tx: Queryable,
  user: Row,
  request: FastifyRequest,
  row: Row,
  to: string,
  why?: string,
  followId?: string,
) {
  const from = statuses.indexOf(row.status);
  const target = statuses.indexOf(to as (typeof statuses)[number]);
  if (from === target || target > from + 1)
    fail(422, "INVALID_TRANSITION", "客户阶段只能逐级晋升");
  if (target < from) {
    requireManager(user);
    parse(reason, why);
    if (followId) fail(422, "INVALID_TRANSITION", "跟进只能触发逐级晋升");
  }
  await tx.query(
    "INSERT INTO crm.customer_status_events(tenant_id,customer_id,from_status,to_status,actor_id,reason,follow_up_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      user.tenant_id,
      row.id,
      row.status,
      to,
      user.id,
      why ?? null,
      followId ?? null,
    ],
  );
  await audit(
    tx,
    user,
    request,
    "customer",
    row.id,
    "status_change",
    { before: row.status, after: to },
    why,
  );
}
async function customerFilters(tx: Queryable, user: Row, query: Row) {
  const filter = await scopeWhere(tx, user, query, "c");
  if (query.archived && !["true", "false"].includes(query.archived))
    fail(422, "VALIDATION_ERROR", "无效归档条件");
  const archived = query.archived === "true";
  if (archived) requireManager(user);
  filter.parts.push(`c.archived_at IS ${archived ? "NOT " : ""}NULL`);
  if (query.status && query.statusGte)
    fail(422, "VALIDATION_ERROR", "状态条件不能同时使用");
  if (query.status)
    filter.add("c.status=?", parse(z.enum(statuses), query.status));
  if (query.statusGte) {
    const status = parse(z.enum(statuses), query.statusGte);
    filter.add(
      "c.status=ANY(?::text[])",
      statuses.slice(statuses.indexOf(status)),
    );
  }
  if (query.source)
    filter.add("c.source=?", parse(z.enum(sources), query.source));
  if (query.keyword) {
    const value = parse(z.string().max(200), query.keyword);
    filter.add(
      "(c.name ILIKE ? OR c.phone ILIKE $N OR c.contact ILIKE $N)",
      "%" + value.replace(/[\\%_]/g, "\\$&") + "%",
    );
    filter.parts[filter.parts.length - 1] = filter.parts
      .at(-1)!
      .replaceAll("$N", "$" + filter.values.length);
  }
  if (query.reminder) {
    if (query.reminder !== "due_soon")
      fail(422, "VALIDATION_ERROR", "无效提醒条件");
    filter.add(
      "c.next_follow_at < ?",
      new Date(shanghaiDay().getTime() + 8 * 86400000).toISOString(),
    );
  }
  return filter;
}
function addArray(
  filter: Awaited<ReturnType<typeof scopeWhere>>,
  query: Row,
  key: string,
  column: string,
  allowed: readonly string[],
) {
  if (query[key] === undefined) return;
  const raw = Array.isArray(query[key]) ? query[key] : [query[key]];
  const values = parse(z.array(z.string()).max(20), raw);
  if (!values.every((x) => allowed.includes(x)))
    fail(422, "VALIDATION_ERROR", "筛选选项无效");
  if (values.length) filter.add(`${column}=ANY(?::text[])`, values);
}
async function activityFilters(tx: Queryable, user: Row, query: Row) {
  const filter = await scopeWhere(tx, user, query, "a");
  addArray(filter, query, "types", "a.type", ["call", "visit"]);
  addArray(filter, query, "results", "a.result", results);
  addArray(filter, query, "nextJudges", "a.next_judge", [
    "revisit",
    "defer",
    "reject",
  ]);
  for (const [key, op] of [
    ["dateFrom", ">="],
    ["dateTo", "<"],
  ] as const) {
    if (query[key])
      filter.add(
        `a.occurred_at ${op} ?`,
        parse(z.iso.datetime({ offset: true }), query[key]),
      );
  }
  if (
    query.dateFrom &&
    query.dateTo &&
    new Date(query.dateFrom) >= new Date(query.dateTo)
  )
    fail(422, "VALIDATION_ERROR", "日期范围无效");
  if (query.keyword) {
    const value = parse(z.string().max(200), query.keyword);
    filter.add(
      "(a.customer_name ILIKE ? OR a.phone ILIKE $N OR a.address ILIKE $N)",
      "%" + value.replace(/[\\%_]/g, "\\$&") + "%",
    );
    filter.parts[filter.parts.length - 1] = filter.parts
      .at(-1)!
      .replaceAll("$N", "$" + filter.values.length);
  }
  return filter;
}

export async function registerBusiness(
  app: FastifyInstance,
  db: Database,
  send: Send,
) {
  app.get("/api/v1/customers", async (request) => {
    const q = queryOf(request);
    const f = await customerFilters(db, request.user!, q);
    const sorts: Row = {
      "lastFollowAt:desc": "c.last_follow_at DESC NULLS LAST,c.id DESC",
      "nextFollowAt:asc": "c.next_follow_at ASC NULLS LAST,c.id DESC",
      "status:asc":
        "CASE c.status WHEN 'added' THEN 0 WHEN 'opened' THEN 1 ELSE 2 END,c.id DESC",
      "createdAt:desc": "c.created_at DESC,c.id DESC",
    };
    const sort = q.sort ?? "lastFollowAt:desc";
    if (!sorts[sort]) fail(422, "VALIDATION_ERROR", "不支持的排序");
    const list = await paginated(
      db,
      customerSelect,
      customerFrom + " WHERE " + f.parts.join(" AND "),
      f.values,
      sorts[sort],
      q,
    );
    return send(request, list.rows.map(customerDto), list.meta);
  });
  app.get("/api/v1/customers/:id", async (request) =>
    send(
      request,
      customerDto(await customer(db, request.user!, idOf(request))),
    ),
  );
  app.post("/api/v1/customers/duplicate-check", async (request) => {
    const body = parse(
      z.object({ phone, excludeCustomerId: z.uuid().optional() }).strict(),
      request.body,
    );
    const q = {
      scope:
        request.user!.role === "admin"
          ? "company"
          : request.user!.role === "manager"
            ? "team"
            : "mine",
    };
    const f = await scopeWhere(db, request.user!, q, "c");
    f.add(
      "(c.phone=? OR regexp_replace(c.alt_phone,'[[:space:]]','','g')=$N)",
      body.phone,
    );
    f.parts[f.parts.length - 1] = f.parts
      .at(-1)!
      .replace("$N", "$" + f.values.length);
    if (body.excludeCustomerId) f.add("c.id<>?", body.excludeCustomerId);
    const rows = (
      await db.query<Row>(
        `SELECT c.id,c.name,c.archived_at ${customerFrom} WHERE ${f.parts.join(" AND ")} ORDER BY c.name,c.id LIMIT 20`,
        f.values,
      )
    ).rows;
    return send(request, {
      duplicates: rows.map((x) => ({
        id: x.id,
        name: x.name,
        archived: Boolean(x.archived_at),
      })),
    });
  });
  app.post("/api/v1/customers", async (request, reply) => {
    const input = parse(customerCreate, request.body);
    const result = await db.transaction(async (tx) => {
      const user = await actorLock(tx, request.user!);
      return idempotent(tx, user, request, async () => {
        const row = await insertCustomer(tx, user, input, user.id);
        await audit(tx, user, request, "customer", row.id, "create", {
          after: customerDto(row),
        });
        return { data: customerDto(await customer(tx, user, row.id)) };
      });
    });
    reply.code(result.status);
    return send(request, result.data);
  });
  app.patch("/api/v1/customers/:id", async (request) => {
    const input = parse(customerPatch, request.body);
    reminder(input.changes.nextFollowAt);
    return send(
      request,
      await db.transaction(async (tx) => {
        const user = await actorLock(tx, request.user!);
        const row = await customer(tx, user, idOf(request), true);
        active(row);
        version(row, input.expectedVersion);
        await update(tx, "customers", row.id, user.tenant_id, input.changes);
        const after = await customer(tx, user, row.id);
        await audit(tx, user, request, "customer", row.id, "update", {
          before: customerDto(row),
          after: customerDto(after),
        });
        return customerDto(after);
      }),
    );
  });
  app.patch("/api/v1/customers/:id/status", async (request) => {
    const body = parse(
      z
        .object({
          expectedVersion,
          toStatus: z.enum(statuses),
          confirmed: z.literal(true),
          reason: reason.optional(),
        })
        .strict(),
      request.body,
    );
    return send(
      request,
      await db.transaction(async (tx) => {
        const user = await actorLock(tx, request.user!);
        const row = await customer(tx, user, idOf(request), true);
        active(row);
        version(row, body.expectedVersion);
        await transition(tx, user, request, row, body.toStatus, body.reason);
        await update(tx, "customers", row.id, user.tenant_id, {
          status: body.toStatus,
        });
        return customerDto(await customer(tx, user, row.id));
      }),
    );
  });
  app.patch("/api/v1/customers/:id/owner", async (request) => {
    const body = parse(
      z.object({ expectedVersion, ownerId: z.uuid(), reason }).strict(),
      request.body,
    );
    return send(
      request,
      await db.transaction(async (tx) => {
        const user = await actorLock(tx, request.user!);
        requireManager(user);
        await assignee(tx, user, body.ownerId);
        const row = await customer(tx, user, idOf(request), true);
        version(row, body.expectedVersion);
        await update(tx, "customers", row.id, user.tenant_id, {
          ownerId: body.ownerId,
        });
        await audit(
          tx,
          user,
          request,
          "customer",
          row.id,
          "transfer",
          {
            before: { ownerId: row.owner_id },
            after: { ownerId: body.ownerId },
          },
          body.reason,
        );
        const changed = (
          await tx.query<Row>(
            `SELECT ${customerSelect} ${customerFrom} WHERE c.tenant_id=$1 AND c.id=$2`,
            [user.tenant_id, row.id],
          )
        ).rows[0];
        return customerDto(changed);
      }),
    );
  });
  for (const operation of ["archive", "restore"] as const)
    app.post(`/api/v1/customers/:id/${operation}`, async (request) => {
      const body = parse(
        z.object({ expectedVersion, reason }).strict(),
        request.body,
      );
      return send(
        request,
        await db.transaction(async (tx) => {
          const user = await actorLock(tx, request.user!);
          if (operation === "restore") requireManager(user);
          const row = await customer(tx, user, idOf(request), true);
          version(row, body.expectedVersion);
          if (operation === "restore") await assignee(tx, user, row.owner_id);
          if (Boolean(row.archived_at) === (operation === "archive"))
            fail(
              409,
              "INVALID_STATE",
              operation === "archive" ? "客户已归档" : "客户未归档",
            );
          const after = await update(tx, "customers", row.id, user.tenant_id, {
            archivedAt:
              operation === "archive" ? new Date().toISOString() : null,
          });
          await audit(
            tx,
            user,
            request,
            "customer",
            row.id,
            operation,
            { before: row.archived_at, after: after.archived_at },
            body.reason,
          );
          return customerDto(await customer(tx, user, row.id));
        }),
      );
    });
  app.get("/api/v1/customers/:id/follow-ups", async (request) => {
    const user = request.user!;
    const row = await customer(db, user, idOf(request));
    const list = await paginated(
      db,
      "f.*,u.display_name AS actor_name",
      "FROM crm.follow_ups f JOIN crm.users u ON (u.tenant_id,u.id)=(f.tenant_id,f.actor_id) WHERE f.tenant_id=$1 AND f.customer_id=$2",
      [user.tenant_id, row.id],
      "f.occurred_at DESC,f.id DESC",
      queryOf(request),
    );
    return send(request, list.rows.map(dto), list.meta);
  });
  app.post("/api/v1/customers/:id/follow-ups", async (request, reply) => {
    const input = parse(followUp, request.body);
    const result = await db.transaction(async (tx) => {
      const user = await actorLock(tx, request.user!);
      return idempotent(tx, user, request, async () => {
        const row = await customer(tx, user, idOf(request), true);
        active(row);
        version(row, input.expectedVersion);
        reminder(input.nextFollowAt);
        const follow = (
          await tx.query<Row>(
            "INSERT INTO crm.follow_ups(tenant_id,customer_id,actor_id,action,content,next_follow_at,reminder_action) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
            [
              user.tenant_id,
              row.id,
              user.id,
              input.action,
              input.content,
              input.nextFollowAt ?? null,
              input.nextFollowAt === undefined
                ? "unchanged"
                : input.nextFollowAt === null
                  ? "clear"
                  : "set",
            ],
          )
        ).rows[0];
        const changes: Row = {
          lastFollowAt: new Date(
            Math.max(
              new Date(row.last_follow_at ?? 0).getTime(),
              new Date(follow.occurred_at).getTime(),
            ),
          ).toISOString(),
        };
        if (input.nextFollowAt !== undefined)
          changes.nextFollowAt = input.nextFollowAt;
        if (input.statusChange) {
          await transition(
            tx,
            user,
            request,
            row,
            input.statusChange.toStatus,
            input.statusChange.reason,
            follow.id,
          );
          changes.status = input.statusChange.toStatus;
        }
        await update(tx, "customers", row.id, user.tenant_id, changes);
        await audit(tx, user, request, "follow_up", follow.id, "create", {
          after: dto(follow),
        });
        return {
          data: {
            followUp: { ...dto(follow), actorName: user.display_name },
            customer: customerDto(await customer(tx, user, row.id)),
          },
        };
      });
    });
    reply.code(result.status);
    return send(request, result.data);
  });
  app.get("/api/v1/activities", async (request) => {
    const f = await activityFilters(db, request.user!, queryOf(request));
    const list = await paginated(
      db,
      activitySelect,
      activityFrom + " WHERE " + f.parts.join(" AND "),
      f.values,
      "a.occurred_at DESC,a.id DESC",
      queryOf(request),
    );
    return send(
      request,
      await Promise.all(
        list.rows.map((x) => activityDto(db, request.user!, x)),
      ),
      list.meta,
    );
  });
  app.get("/api/v1/activities/summary", async (request) => {
    const f = await scopeWhere(db, request.user!, queryOf(request), "a");
    const row = (
      await db.query<Row>(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE a.type='call')::int AS calls,count(*) FILTER(WHERE a.type='visit')::int AS visits,count(*) FILTER(WHERE a.result='contact_added')::int AS contact_added ${activityFrom} WHERE ${f.parts.join(" AND ")}`,
        f.values,
      )
    ).rows[0];
    return send(request, dto(row));
  });
  app.get("/api/v1/activities/:id", async (request) =>
    send(
      request,
      await activityDto(
        db,
        request.user!,
        await activity(db, request.user!, idOf(request)),
      ),
    ),
  );
  app.post("/api/v1/activities", async (request, reply) => {
    const body = parse(activityCreate, request.body);
    const result = await db.transaction(async (tx) => {
      const user = await actorLock(tx, request.user!);
      return idempotent(tx, user, request, async () => {
        const row = (
          await tx.query<Row>(
            "INSERT INTO crm.activities(tenant_id,owner_id,type,customer_name,phone,address,result,next_judge,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              user.tenant_id,
              user.id,
              body.type,
              body.customerName,
              body.phone ?? "",
              body.address ?? "",
              body.result,
              body.nextJudge ?? deriveJudge(body.result),
              body.note ?? "",
            ],
          )
        ).rows[0];
        await audit(tx, user, request, "activity", row.id, "create", {
          after: dto(row),
        });
        return {
          data: await activityDto(tx, user, {
            ...row,
            owner_name: user.display_name,
          }),
        };
      });
    });
    reply.code(result.status);
    return send(request, result.data);
  });
  app.patch("/api/v1/activities/:id", async (request) => {
    requireAdmin(request.user!);
    const body = parse(
      z
        .object({
          expectedVersion,
          changes: z
            .object({
              type: z.enum(["call", "visit"]).optional(),
              customerName: z.string().trim().min(1).max(200).optional(),
              phone: z.union([phone, z.literal("")]).optional(),
              address: z.string().trim().max(500).optional(),
              result: z.enum(results).optional(),
              nextJudge: z.enum(["revisit", "defer", "reject"]).optional(),
              note: z.string().trim().max(4000).optional(),
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
        const user = await actorLock(tx, request.user!);
        requireAdmin(user);
        const row = await activity(tx, user, idOf(request), true);
        version(row, body.expectedVersion);
        if (
          row.converted_customer_id &&
          ("type" in body.changes || "result" in body.changes)
        )
          fail(422, "INVALID_CHANGE", "已转客户记录不能更改类型或结果");
        const merged = parse(activityCreate, {
          type: row.type,
          customerName: row.customer_name,
          phone: row.phone,
          address: row.address,
          result: row.result,
          nextJudge: row.next_judge,
          note: row.note,
          ...body.changes,
        });
        await update(tx, "activities", row.id, user.tenant_id, merged);
        const after = await activity(tx, user, row.id);
        await audit(
          tx,
          user,
          request,
          "activity",
          row.id,
          "correct",
          { before: dto(row), after: dto(after) },
          body.reason,
        );
        return activityDto(tx, user, after);
      }),
    );
  });
  app.post("/api/v1/activities/:id/convert", async (request, reply) => {
    const body = parse(convert, request.body);
    const result = await db.transaction(async (tx) => {
      const user = await actorLock(tx, request.user!);
      return idempotent(tx, user, request, async () => {
        let target: Row | undefined;
        if (body.mode === "link") {
          target = await customer(tx, user, body.customerId, true);
          active(target);
        }
        const row = await activity(tx, user, idOf(request), true);
        if (row.result !== "contact_added")
          fail(422, "NOT_CONVERTIBLE", "只有成功添加联系方式的记录可以转客户");
        if (row.converted_customer_id) {
          if (
            body.mode === "link" &&
            row.converted_customer_id === body.customerId
          )
            return {
              data: {
                activity: await activityDto(tx, user, row),
                customer: customerDto(target!),
              },
              status: 200,
            };
          fail(409, "ALREADY_CONVERTED", "此记录已转客户，请查看现有关联");
        }
        version(row, body.expectedVersion);
        if (body.mode === "create") {
          if (body.ownerId) requireManager(user);
          const ownerId = body.ownerId ?? row.owner_id;
          await assignee(tx, user, ownerId);
          target = await insertCustomer(
            tx,
            user,
            { ...body.customer, source: row.type },
            ownerId,
          );
          await audit(
            tx,
            user,
            request,
            "customer",
            target.id,
            "create_from_activity",
            { activityId: row.id, after: customerDto(target) },
          );
        }
        await update(tx, "activities", row.id, user.tenant_id, {
          convertedCustomerId: target!.id,
          convertedAt: new Date().toISOString(),
          convertedBy: user.id,
        });
        await audit(tx, user, request, "activity", row.id, "convert", {
          customerId: target!.id,
        });
        return {
          data: {
            activity: await activityDto(
              tx,
              user,
              await activity(tx, user, row.id),
            ),
            customer: customerDto(await customer(tx, user, target!.id)),
          },
        };
      });
    });
    reply.code(result.status);
    return send(request, result.data);
  });
  app.get("/api/v1/dashboard", async (request) =>
    send(
      request,
      await db.transaction(
        async (tx) => {
          const user = request.user!;
          const f = await scopeWhere(tx, user, queryOf(request), "c");
          const where = f.parts.join(" AND ") + " AND c.archived_at IS NULL";
          const totals = (
            await tx.query<Row>(
              `SELECT count(*)::int AS total,count(*) FILTER(WHERE c.status='added')::int AS added,count(*) FILTER(WHERE c.status='opened')::int AS opened,count(*) FILTER(WHERE c.status='shipped')::int AS shipped ${customerFrom} WHERE ${where}`,
              f.values,
            )
          ).rows[0];
          const today = shanghaiDay();
          const end = new Date(today.getTime() + 86400000);
          const af = await scopeWhere(tx, user, queryOf(request), "a");
          af.add("a.type=?", "call");
          af.add("a.occurred_at>=?", today.toISOString());
          af.add("a.occurred_at<?", end.toISOString());
          const calls = (
            await tx.query<Row>(
              `SELECT count(*)::int AS total,count(*) FILTER(WHERE a.result='contact_added')::int AS success ${activityFrom} WHERE ${af.parts.join(" AND ")}`,
              af.values,
            )
          ).rows[0];
          const dueParams = [
            ...f.values,
            new Date(today.getTime() + 8 * 86400000).toISOString(),
          ];
          const dueWhere = where + ` AND c.next_follow_at<$${dueParams.length}`;
          const pending = await paginated(
            tx,
            customerSelect,
            customerFrom + " WHERE " + dueWhere,
            dueParams,
            "c.next_follow_at,c.id",
            { page: 1, pageSize: 4 },
          );
          const opened = totals.opened + totals.shipped;
          return {
            scope: f.scope,
            timeZone: "Asia/Shanghai",
            asOf: new Date().toISOString(),
            customers: {
              total: totals.total,
              opened,
              shipped: totals.shipped,
              openedRate: totals.total
                ? Math.round((opened / totals.total) * 100)
                : null,
              shippedRate: totals.total
                ? Math.round((totals.shipped / totals.total) * 100)
                : null,
            },
            stages: {
              added: totals.added,
              opened: totals.opened,
              shipped: totals.shipped,
            },
            todayCalls: {
              total: calls.total,
              contactAdded: calls.success,
              rate: calls.total
                ? Math.round((calls.success / calls.total) * 100)
                : null,
            },
            pendingFollowUps: {
              items: pending.rows.map(customerDto),
              total: pending.meta.total,
            },
            shipmentVolume: {
              dataStatus: "not_connected",
              week: { total: null, buckets: null },
              month: { total: null, buckets: null },
            },
          };
        },
        { readOnly: true },
      ),
    ),
  );
}
