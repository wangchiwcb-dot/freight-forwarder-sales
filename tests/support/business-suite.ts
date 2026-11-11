import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createHarness,
  customerPayload,
  activityPayload,
  ids,
  origin,
  qaPassword,
  success,
  type Harness,
} from "./harness.js";

export function businessSuite(label: string, native: boolean) {
  describe(label, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness(native);
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h?.close();
    });

    it("requires login and same-origin CSRF for writes", async () => {
      expect(
        (await h.app.inject({ method: "GET", url: "/api/v1/customers" }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            headers: { origin: "https://untrusted.example" },
            payload: { username: "sales_a", password: qaPassword },
          })
        ).statusCode,
      ).toBe(403);
      const a = await h.login("sales_a");
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: "/api/v1/customers",
            headers: {
              origin,
              cookie: a.cookie,
              "idempotency-key": randomUUID(),
            },
            payload: customerPayload(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customers",
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it("enforces first password change and revokes the previous session", async () => {
      await h.owner.query(
        "UPDATE crm.users SET must_change_password=true WHERE id=$1",
        [ids.salesA],
      );
      const a = await h.login("sales_a");
      expect((await a.request("GET", "/customers")).statusCode).toBe(403);
      expect(
        (
          await a.request("POST", "/auth/change-password", {
            currentPassword: "incorrect-password",
            newPassword: "New-isolated-password-123!",
          })
        ).statusCode,
      ).toBe(422);
      success(
        await a.request("POST", "/auth/change-password", {
          currentPassword: qaPassword,
          newPassword: "New-isolated-password-123!",
        }),
      );
      expect((await a.request("GET", "/auth/me")).statusCode).toBe(401);
      const again = await h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: {
          username: "sales_a",
          password: "New-isolated-password-123!",
        },
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data.mustChangePassword).toBe(false);
    });

    it("preserves a database-backed session after the API app restarts", async () => {
      const a = await h.login("sales_a");
      const c = success(
        await a.request(
          "POST",
          "/customers",
          customerPayload("重启后仍可访问"),
        ),
        201,
      );
      await h.restart();
      expect(success(await a.request("GET", "/customers/" + c.id)).id).toBe(
        c.id,
      );
      success(await a.request("POST", "/auth/logout"));
      await h.restart();
      expect((await a.request("GET", "/auth/me")).statusCode).toBe(401);
    });

    it("filters lists, details, aggregates and duplicate lookup by the same owner/team scope", async () => {
      const a = await h.login("sales_a"),
        b = await h.login("sales_b"),
        m = await h.login("manager");
      const own = success(
        await a.request("POST", "/customers", customerPayload("A客户")),
        201,
      );
      const hidden = success(
        await b.request("POST", "/customers", customerPayload("B客户")),
        201,
      );
      const list = await a.request("GET", "/customers");
      expect(list.json().meta.total).toBe(1);
      expect(list.json().data[0].id).toBe(own.id);
      expect(
        (await a.request("GET", "/customers/" + hidden.id)).statusCode,
      ).toBe(404);
      expect(
        (await a.request("GET", "/customers?scope=company")).statusCode,
      ).toBe(403);
      expect((await a.request("GET", "/customers?scope=team")).statusCode).toBe(
        403,
      );
      const team = success(await m.request("GET", "/customers?scope=team"));
      expect(team.map((x: any) => x.id)).toEqual([own.id]);
      expect(
        (await m.request("GET", "/customers/" + hidden.id)).statusCode,
      ).toBe(404);
      const dup = success(
        await a.request("POST", "/customers/duplicate-check", {
          phone: "13800000000",
        }),
      );
      expect(dup.duplicates.map((x: any) => x.id)).toEqual([own.id]);
      const dash = success(await a.request("GET", "/dashboard"));
      expect(dash.customers.total).toBe(1);
    });

    it("rejects company/owner injection and keeps ordinary edits separate from status changes", async () => {
      const a = await h.login("sales_a");
      expect(
        (
          await a.request("POST", "/customers", {
            ...customerPayload(),
            ownerId: ids.salesB,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await a.request("POST", "/customers", {
            ...customerPayload(),
            tenantId: "other",
          })
        ).statusCode,
      ).toBe(422);
      const c = success(
        await a.request("POST", "/customers", customerPayload()),
        201,
      );
      expect(
        (
          await a.request("PATCH", "/customers/" + c.id, {
            expectedVersion: c.version,
            changes: { status: "shipped" },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await a.request("PATCH", "/customers/" + c.id + "/status", {
            expectedVersion: c.version,
            toStatus: "shipped",
            confirmed: true,
          })
        ).statusCode,
      ).toBe(422);
    });

    it("keeps another company hidden even from the current company administrator", async () => {
      const admin = await h.login("admin_a"),
        foreignId = randomUUID();
      await h.owner.query(
        "INSERT INTO crm.customers(id,tenant_id,owner_id,created_by,name,phone,source) VALUES($1,'other',$2,$2,'其他公司的客户','13800000000','call')",
        [foreignId, ids.outsider],
      );
      expect(
        (await admin.request("GET", "/customers/" + foreignId)).statusCode,
      ).toBe(404);
      expect(
        (await admin.request("GET", "/customers?scope=company")).json().meta
          .total,
      ).toBe(0);
      expect(
        success(await admin.request("GET", "/dashboard?scope=company"))
          .customers.total,
      ).toBe(0);
      expect(
        success(
          await admin.request("POST", "/customers/duplicate-check", {
            phone: "13800000000",
          }),
        ).duplicates,
      ).toEqual([]);
      expect(
        (
          await admin.request("PATCH", "/customers/" + foreignId, {
            expectedVersion: 1,
            changes: { name: "越权编辑" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await h.owner.query<{ name: string }>(
            "SELECT name FROM crm.customers WHERE id=$1",
            [foreignId],
          )
        ).rows[0].name,
      ).toBe("其他公司的客户");
    });

    it("lets only company administrators reload current employee and team versions after a conflict", async () => {
      const admin = await h.login("admin_a"),
        sales = await h.login("sales_a");
      const user = success(await admin.request("GET", "/users/" + ids.salesB));
      expect(user).toMatchObject({
        id: ids.salesB,
        version: 1,
        teamId: ids.teamB,
        teamName: "B组",
      });
      for (const key of [
        "passwordHash",
        "password_hash",
        "sessionVersion",
        "session_version",
      ])
        expect(user).not.toHaveProperty(key);
      success(
        await admin.request("PATCH", "/users/" + ids.salesB, {
          expectedVersion: user.version,
          changes: { displayName: "更新后的员工" },
          reason: "更新显示名称",
        }),
      );
      expect(
        (
          await admin.request("PATCH", "/users/" + ids.salesB, {
            expectedVersion: user.version,
            changes: { displayName: "过期修改" },
            reason: "模拟冲突",
          })
        ).statusCode,
      ).toBe(409);
      expect(
        success(await admin.request("GET", "/users/" + ids.salesB)),
      ).toMatchObject({ displayName: "更新后的员工", version: 2 });
      const team = success(await admin.request("GET", "/teams/" + ids.teamB));
      expect(team).toMatchObject({ id: ids.teamB, version: 1, name: "B组" });
      success(
        await admin.request("PATCH", "/teams/" + ids.teamB, {
          expectedVersion: team.version,
          changes: { name: "更新后的B组" },
          reason: "更新团队名称",
        }),
      );
      expect(
        (
          await admin.request("PATCH", "/teams/" + ids.teamB, {
            expectedVersion: team.version,
            changes: { name: "过期修改" },
            reason: "模拟冲突",
          })
        ).statusCode,
      ).toBe(409);
      expect(
        success(await admin.request("GET", "/teams/" + ids.teamB)),
      ).toMatchObject({ name: "更新后的B组", version: 2 });
      for (const path of ["/users/" + ids.salesB, "/teams/" + ids.teamB])
        expect((await sales.request("GET", path)).statusCode).toBe(403);
      for (const path of [
        "/users/" + ids.outsider,
        "/teams/" + ids.outsiderTeam,
      ])
        expect((await admin.request("GET", path)).statusCode).toBe(404);
    });

    it("saves follow-up, reminder and optional single-stage upgrade atomically", async () => {
      const a = await h.login("sales_a");
      const c = success(
        await a.request("POST", "/customers", customerPayload()),
        201,
      );
      const next = new Date(Date.now() + 3 * 86400000).toISOString();
      const first = success(
        await a.request("POST", `/customers/${c.id}/follow-ups`, {
          expectedVersion: c.version,
          action: "order",
          content: "核实开户情况",
          nextFollowAt: next,
          statusChange: { toStatus: "opened", confirmed: true },
        }),
        201,
      );
      expect(first.customer.status).toBe("opened");
      expect(new Date(first.customer.nextFollowAt).getTime()).toBe(
        new Date(next).getTime(),
      );
      const second = success(
        await a.request("POST", `/customers/${c.id}/follow-ups`, {
          expectedVersion: first.customer.version,
          action: "order",
          content: "仅记录下单，不确认走货",
        }),
        201,
      );
      expect(second.customer.status).toBe("opened");
      expect(second.customer.nextFollowAt).toBe(first.customer.nextFollowAt);
      const third = success(
        await a.request("POST", `/customers/${c.id}/follow-ups`, {
          expectedVersion: second.customer.version,
          action: "greeting",
          content: "取消后续提醒",
          nextFollowAt: null,
        }),
        201,
      );
      expect(third.customer.nextFollowAt).toBeNull();
      const timeline = await a.request("GET", `/customers/${c.id}/follow-ups`);
      expect(timeline.json().meta.total).toBe(3);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customer_status_events WHERE customer_id=$1",
            [c.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("does not duplicate requests and does not confuse identical keys on different customers", async () => {
      const a = await h.login("sales_a"),
        key = randomUUID(),
        payload = customerPayload();
      const c = success(
        await a.request("POST", "/customers", payload, key),
        201,
      );
      expect(
        success(await a.request("POST", "/customers", payload, key), 201).id,
      ).toBe(c.id);
      expect(
        (
          await a.request(
            "POST",
            "/customers",
            customerPayload("different"),
            key,
          )
        ).statusCode,
      ).toBe(409);
      const other = success(
          await a.request("POST", "/customers", customerPayload("another")),
          201,
        ),
        followKey = randomUUID();
      const follow = {
        expectedVersion: 1,
        action: "greeting",
        content: "相同内容，用于不同客户",
      };
      success(
        await a.request(
          "POST",
          `/customers/${c.id}/follow-ups`,
          follow,
          followKey,
        ),
        201,
      );
      success(
        await a.request(
          "POST",
          `/customers/${other.id}/follow-ups`,
          follow,
          followKey,
        ),
        201,
      );
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.follow_ups",
          )
        ).rows[0].n,
      ).toBe(2);
    });

    it("rolls back a failed write together with its idempotency reservation", async () => {
      const a = await h.login("sales_a"),
        c = success(
          await a.request("POST", "/customers", customerPayload()),
          201,
        ),
        key = randomUUID();
      const failed = await a.request(
        "POST",
        `/customers/${c.id}/follow-ups`,
        { expectedVersion: 999, action: "greeting", content: "失败重试" },
        key,
      );
      expect(failed.statusCode).toBe(409);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.idempotency_keys WHERE key=$1",
            [key],
          )
        ).rows[0].n,
      ).toBe(0);
      success(
        await a.request(
          "POST",
          `/customers/${c.id}/follow-ups`,
          {
            expectedVersion: c.version,
            action: "greeting",
            content: "失败重试",
          },
          key,
        ),
        201,
      );
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.follow_ups",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("replays a saved follow-up across Shanghai midnight without revalidating its old reminder", async () => {
      const start = (
        await h.owner.query<{ start: Date | string }>(
          "SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS start",
        )
      ).rows[0].start;
      const day = new Date(start).getTime(),
        midnight = day + 86400000;
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(midnight - 1000));
        const a = await h.login("sales_a");
        const c = success(
            await a.request("POST", "/customers", customerPayload()),
            201,
          ),
          key = randomUUID();
        const payload = {
          expectedVersion: c.version,
          action: "greeting",
          content: "午夜前保存的跟进",
          nextFollowAt: new Date(day + 10 * 3600000).toISOString(),
        };
        const first = success(
          await a.request(
            "POST",
            `/customers/${c.id}/follow-ups`,
            payload,
            key,
          ),
          201,
        );
        vi.setSystemTime(new Date(midnight + 1000));
        const replay = success(
          await a.request(
            "POST",
            `/customers/${c.id}/follow-ups`,
            payload,
            key,
          ),
          201,
        );
        expect(replay.followUp.id).toBe(first.followUp.id);
        expect(replay.customer.version).toBe(first.customer.version);
        const fresh = await a.request("POST", `/customers/${c.id}/follow-ups`, {
          ...payload,
          expectedVersion: first.customer.version,
        });
        expect(fresh.statusCode, fresh.body).toBe(422);
        expect(fresh.json().error.code).toBe("VALIDATION_ERROR");
        expect(
          (
            await h.owner.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM crm.follow_ups",
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("converts only after successful persistence and can link an existing customer without overwriting it", async () => {
      const a = await h.login("sales_a");
      const act = success(
        await a.request("POST", "/activities", activityPayload()),
        201,
      );
      expect(
        success(await a.request("GET", "/activities/" + act.id)).converted,
      ).toBe(false);
      const invalid = await a.request("POST", `/activities/${act.id}/convert`, {
        expectedVersion: act.version,
        mode: "create",
        customer: { name: "缺手机号" },
      });
      expect(invalid.statusCode).toBe(422);
      expect(
        success(await a.request("GET", "/activities/" + act.id)).converted,
      ).toBe(false);
      const c = success(
        await a.request("POST", "/customers", customerPayload("已有客户")),
        201,
      );
      const converted = success(
        await a.request("POST", `/activities/${act.id}/convert`, {
          expectedVersion: act.version,
          mode: "link",
          customerId: c.id,
        }),
        201,
      );
      expect(converted.customer.name).toBe("已有客户");
      expect(converted.activity.converted).toBe(true);
      const repeat = await a.request("POST", `/activities/${act.id}/convert`, {
        expectedVersion: act.version,
        mode: "create",
        customer: { name: "重复", phone: "13800000000" },
      });
      expect(repeat.statusCode).toBe(409);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customers",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("rejects stale edits, archives without dropping history, and restores with the proper role", async () => {
      const a = await h.login("sales_a"),
        m = await h.login("manager");
      let c = success(
        await a.request("POST", "/customers", customerPayload()),
        201,
      );
      const recorded = success(
        await a.request("POST", `/customers/${c.id}/follow-ups`, {
          expectedVersion: c.version,
          action: "greeting",
          content: "保留历史",
        }),
        201,
      );
      c = recorded.customer;
      expect(
        (
          await a.request("PATCH", "/customers/" + c.id, {
            expectedVersion: 1,
            changes: { name: "过期编辑" },
          })
        ).statusCode,
      ).toBe(409);
      const archived = success(
        await a.request("POST", `/customers/${c.id}/archive`, {
          expectedVersion: c.version,
          reason: "阶段归档",
        }),
      );
      expect((await a.request("GET", "/customers")).json().meta.total).toBe(0);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.follow_ups WHERE customer_id=$1",
            [c.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await a.request("POST", `/customers/${c.id}/restore`, {
            expectedVersion: archived.version,
            reason: "恢复",
          })
        ).statusCode,
      ).toBe(403);
      const restored = success(
        await m.request("POST", `/customers/${c.id}/restore`, {
          expectedVersion: archived.version,
          reason: "恢复跟进",
        }),
      );
      expect(restored.archivedAt).toBeNull();
    });

    it("preserves all overdue reminders and computes cumulative opened counts and call-only success", async () => {
      const a = await h.login("sales_a");
      const c = success(
        await a.request("POST", "/customers", customerPayload()),
        201,
      );
      await h.owner.query(
        "UPDATE crm.customers SET status='shipped',next_follow_at=now()-interval '15 days' WHERE id=$1",
        [c.id],
      );
      success(await a.request("POST", "/activities", activityPayload()), 201);
      success(
        await a.request("POST", "/activities", {
          type: "visit",
          customerName: "扫楼",
          address: "测试园区",
          result: "contact_added",
        }),
        201,
      );
      const d = success(await a.request("GET", "/dashboard"));
      expect(d.customers).toMatchObject({ total: 1, opened: 1, shipped: 1 });
      expect(d.pendingFollowUps.total).toBe(1);
      expect(d.todayCalls).toMatchObject({
        total: 1,
        contactAdded: 1,
        rate: 100,
      });
      expect(d.shipmentVolume.dataStatus).toBe("not_connected");
      expect(d.shipmentVolume.week.total).toBeNull();
      const opened = await a.request("GET", "/customers?statusGte=opened");
      expect(opened.json().meta.total).toBe(d.customers.opened);
      const summary = success(
        await a.request("GET", "/activities/summary?types=visit"),
      );
      expect(summary).toMatchObject({
        total: 2,
        calls: 1,
        visits: 1,
        contactAdded: 2,
      });
    });

    it("uses Shanghai midnight and an exclusive end for daily activity metrics", async () => {
      const a = await h.login("sales_a");
      const midnight = (
        await h.owner.query<{ start: Date | string }>(
          "SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS start",
        )
      ).rows[0].start;
      const start = new Date(midnight).getTime(),
        end = start + 86400000,
        created: string[] = [];
      for (const [index, timestamp] of [
        start - 1,
        start,
        end - 1,
        end,
      ].entries()) {
        const row = success(
          await a.request(
            "POST",
            "/activities",
            activityPayload("日期边界 " + index),
          ),
          201,
        );
        created.push(row.id);
        await h.owner.query(
          "UPDATE crm.activities SET occurred_at=$1 WHERE id=$2",
          [new Date(timestamp).toISOString(), row.id],
        );
      }
      const dashboard = success(await a.request("GET", "/dashboard"));
      expect(dashboard.timeZone).toBe("Asia/Shanghai");
      expect(dashboard.todayCalls.total).toBe(2);
      const range = new URLSearchParams({
        dateFrom: new Date(start).toISOString(),
        dateTo: new Date(end).toISOString(),
      });
      const list = await a.request("GET", "/activities?" + range);
      expect(list.json().meta.total).toBe(2);
      expect(list.json().data.map((row: any) => row.id)).toEqual([
        created[2],
        created[1],
      ]);
      expect(
        success(await a.request("GET", "/activities/summary?" + range)).total,
      ).toBe(4);
    });

    it("does not leak an idempotent response after a customer is transferred away", async () => {
      const a = await h.login("sales_a"),
        admin = await h.login("admin_a"),
        key = randomUUID(),
        payload = customerPayload();
      const c = success(
        await a.request("POST", "/customers", payload, key),
        201,
      );
      success(
        await admin.request("PATCH", `/customers/${c.id}/owner`, {
          expectedVersion: c.version,
          ownerId: ids.salesB,
          reason: "客户交接",
        }),
      );
      expect((await a.request("GET", "/customers/" + c.id)).statusCode).toBe(
        404,
      );
      expect(
        (await a.request("POST", "/customers", payload, key)).statusCode,
      ).toBe(404);
    });

    it("revokes a disabled employee and requires an active owner for their historical conversion", async () => {
      const a = await h.login("sales_a"),
        m = await h.login("manager"),
        admin = await h.login("admin_a");
      const act = success(
        await a.request("POST", "/activities", activityPayload()),
        201,
      );
      success(
        await admin.request("PATCH", "/users/" + ids.salesA, {
          expectedVersion: 1,
          changes: { enabled: false },
          reason: "离职交接",
        }),
      );
      expect((await a.request("GET", "/auth/me")).statusCode).toBe(401);
      const payload = {
        expectedVersion: act.version,
        mode: "create",
        customer: { name: "新归属客户", phone: "13800000000" },
      };
      const bad = await m.request(
        "POST",
        `/activities/${act.id}/convert`,
        payload,
      );
      expect(bad.statusCode, bad.body).toBe(422);
      expect(bad.json().error.code).toBe("OWNER_INACTIVE");
      const done = success(
        await m.request("POST", `/activities/${act.id}/convert`, {
          ...payload,
          ownerId: ids.manager,
        }),
        201,
      );
      expect(done.customer.ownerId).toBe(ids.manager);
      expect(done.activity.ownerId).toBe(ids.salesA);
    });
  });
}
