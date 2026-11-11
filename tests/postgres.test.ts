import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { businessSuite } from "./support/business-suite.js";
import {
  activityPayload,
  createHarness,
  customerPayload,
  ids,
  success,
  type Harness,
} from "./support/harness.js";

const enabled = process.env.QA_ISOLATED_PG === "1";
if (enabled)
  businessSuite(
    "Sales API with native PostgreSQL and the restricted runtime role",
    true,
  );

describe.skipIf(!enabled)(
  "Native PostgreSQL privilege and concurrency guarantees",
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness(true);
    });
    beforeEach(async () => {
      await h.reset();
    });
    afterAll(async () => {
      await h?.close();
    });

    it("rejects runtime DDL, destructive business writes and mutations of append-only history", async () => {
      const a = await h.login("sales_a");
      const c = success(
        await a.request("POST", "/customers", customerPayload()),
        201,
      );
      success(
        await a.request("POST", `/customers/${c.id}/follow-ups`, {
          expectedVersion: c.version,
          action: "greeting",
          content: "历史记录",
        }),
        201,
      );
      for (const sql of [
        "CREATE TABLE crm.forbidden_runtime_ddl(id int)",
        "DELETE FROM crm.customers",
        "UPDATE crm.follow_ups SET content='覆盖'",
        "DELETE FROM crm.customer_status_events",
        "UPDATE crm.audit_logs SET action='hidden'",
        "DELETE FROM crm.audit_logs",
        "UPDATE crm.tenants SET name='changed'",
        "DELETE FROM crm.sessions",
      ])
        await expect(h.db.query(sql)).rejects.toMatchObject({ code: "42501" });
      const runtimeUrl = new URL(process.env.QA_PG_RUNTIME_URL!);
      runtimeUrl.pathname = "/forbidden_sales_qa";
      const forbidden = new Client({ connectionString: runtimeUrl.toString() });
      try {
        await expect(forbidden.connect()).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await forbidden.end().catch(() => {});
      }
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customers",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("serializes two users converting the same record so only one customer is created", async () => {
      const a = await h.login("sales_a"),
        m = await h.login("manager");
      const act = success(
        await a.request("POST", "/activities", activityPayload()),
        201,
      );
      const payload = {
        expectedVersion: act.version,
        mode: "create",
        customer: { name: "并发转换", phone: "13800000000" },
      };
      const responses = await Promise.all([
        a.request("POST", `/activities/${act.id}/convert`, payload),
        m.request("POST", `/activities/${act.id}/convert`, payload),
      ]);
      expect(
        responses.map((r) => r.statusCode).sort(),
        responses.map((r) => r.body).join("\n"),
      ).toEqual([201, 409]);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customers",
          )
        ).rows[0].n,
      ).toBe(1);
      const data = success(await a.request("GET", "/activities/" + act.id));
      expect(data.converted).toBe(true);
      expect(data.convertedCustomerId).toBeTruthy();
    });

    it("serializes duplicate in-flight requests using the same idempotency target and key", async () => {
      const a = await h.login("sales_a"),
        key = randomUUID(),
        body = customerPayload("同请求并发");
      const responses = await Promise.all([
        a.request("POST", "/customers", body, key),
        a.request("POST", "/customers", body, key),
      ]);
      const first = success(responses[0], 201),
        second = success(responses[1], 201);
      expect(first.id).toBe(second.id);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.customers",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await h.owner.query<{ state: string }>(
            "SELECT state FROM crm.idempotency_keys WHERE key=$1",
            [key],
          )
        ).rows,
      ).toEqual([{ state: "completed" }]);
    });

    it("allows one of two stale-version edits and preserves the winning value", async () => {
      const a = await h.login("sales_a"),
        c = success(
          await a.request("POST", "/customers", customerPayload()),
          201,
        );
      const responses = await Promise.all(
        ["更新甲", "更新乙"].map((name) =>
          a.request("PATCH", "/customers/" + c.id, {
            expectedVersion: c.version,
            changes: { name },
          }),
        ),
      );
      expect(
        responses.map((r) => r.statusCode).sort(),
        responses.map((r) => r.body).join("\n"),
      ).toEqual([200, 409]);
      const winner = responses.find((r) => r.statusCode === 200)!.json().data;
      const actual = success(await a.request("GET", "/customers/" + c.id));
      expect(actual.name).toBe(winner.name);
      expect(actual.version).toBe(c.version + 1);
    });

    it("keeps one enabled administrator when two administrators concurrently disable themselves", async () => {
      const a = await h.login("admin_a"),
        b = await h.login("admin_b");
      const responses = await Promise.all([
        a.request("PATCH", "/users/" + ids.adminA, {
          expectedVersion: 1,
          changes: { enabled: false },
          reason: "并发管理员检查A",
        }),
        b.request("PATCH", "/users/" + ids.adminB, {
          expectedVersion: 1,
          changes: { enabled: false },
          reason: "并发管理员检查B",
        }),
      ]);
      expect(
        responses.filter((r) => r.statusCode === 200),
        responses.map((r) => r.body).join("\n"),
      ).toHaveLength(1);
      const rejected = responses.find((r) => r.statusCode !== 200)!;
      expect([409, 422]).toContain(rejected.statusCode);
      expect(
        (
          await h.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM crm.users WHERE tenant_id='szzhhq' AND role='admin' AND enabled=true",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("rechecks owner activity after waiting for a simultaneous disabling transaction", async () => {
      const a = await h.login("sales_a"),
        m = await h.login("manager");
      const act = success(
        await a.request("POST", "/activities", activityPayload()),
        201,
      );
      const blocker = new Client({
        connectionString: process.env.QA_PG_ADMIN_URL,
      });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM crm.users WHERE id=$1 FOR UPDATE", [
          ids.salesA,
        ]);
        const conversion = m.request("POST", `/activities/${act.id}/convert`, {
          expectedVersion: act.version,
          mode: "create",
          customer: { name: "禁用竞态", phone: "13800000000" },
        });
        // The explicit database lock orders the conflict without any timing sleep.
        await blocker.query(
          "UPDATE crm.users SET enabled=false,session_version=session_version+1 WHERE id=$1",
          [ids.salesA],
        );
        await blocker.query("COMMIT");
        const result = await conversion;
        expect(result.statusCode, result.body).toBe(422);
        expect(result.json().error.code).toBe("OWNER_INACTIVE");
        expect(
          (
            await h.owner.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM crm.customers",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
      }
    });

    it("keeps organization writes usable with a read-only tenant table and rejects disabling an occupied team", async () => {
      const admin = await h.login("admin_a");
      const created = success(
        await admin.request("POST", "/teams", { name: "新团队" }),
        201,
      );
      expect(created.name).toBe("新团队");
      const occupied = await admin.request("PATCH", "/teams/" + ids.teamA, {
        expectedVersion: 1,
        changes: { enabled: false },
        reason: "应拒绝仍有成员",
      });
      expect([409, 422]).toContain(occupied.statusCode);
      expect(
        (
          await h.owner.query<{ enabled: boolean }>(
            "SELECT enabled FROM crm.teams WHERE id=$1",
            [ids.teamA],
          )
        ).rows[0].enabled,
      ).toBe(true);
    });
  },
);
