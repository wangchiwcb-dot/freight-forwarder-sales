import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { FastifyInstance, InjectOptions } from "fastify";
import { expect } from "vitest";
import { createApp } from "../../server/app.js";
import {
  openDatabase,
  type Database,
  type Queryable,
} from "../../server/db.js";
import { loadConfig } from "../../server/config.js";
import { hashPassword } from "../../server/auth.js";

export const ids = {
  teamA: "10000000-0000-4000-8000-000000000001",
  teamB: "10000000-0000-4000-8000-000000000002",
  outsiderTeam: "10000000-0000-4000-8000-000000000003",
  salesA: "20000000-0000-4000-8000-000000000001",
  salesB: "20000000-0000-4000-8000-000000000002",
  manager: "20000000-0000-4000-8000-000000000003",
  adminA: "20000000-0000-4000-8000-000000000004",
  adminB: "20000000-0000-4000-8000-000000000005",
  outsider: "20000000-0000-4000-8000-000000000006",
};
export const qaPassword = "Isolated-QA-Password-Only-42!";
export const origin = "http://127.0.0.1:4193";
export interface Session {
  cookie: string;
  csrf: string;
  request(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): ReturnType<FastifyInstance["inject"]>;
}
export interface Harness {
  db: Database;
  owner: Queryable;
  app: FastifyInstance;
  reset(): Promise<void>;
  restart(): Promise<void>;
  login(username: string): Promise<Session>;
  close(): Promise<void>;
}
export async function createHarness(native = false): Promise<Harness> {
  if (native && process.env.QA_ISOLATED_PG !== "1")
    throw new Error("Native QA requires the isolated cluster runner");
  const runtimeUrl = process.env.QA_PG_RUNTIME_URL;
  const adminUrl = process.env.QA_PG_ADMIN_URL;
  if (
    native &&
    (!adminUrl ||
      !runtimeUrl ||
      new URL(adminUrl).hostname !== "127.0.0.1" ||
      new URL(adminUrl).pathname !== "/sales_workbench_test")
  )
    throw new Error("Refusing a non-isolated database");
  const db = await openDatabase(
    native
      ? { source: "postgres", databaseUrl: runtimeUrl }
      : { source: "demo", demoPath: "memory://" },
  );
  let superClient: Client | undefined;
  const owner: Queryable = native
    ? await (async () => {
        superClient = new Client({ connectionString: adminUrl });
        await superClient.connect();
        return {
          async query<T>(sql: string, values: unknown[] = []) {
            const result = await superClient!.query(sql, values);
            return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
          },
        };
      })()
    : db;
  if (!native) {
    // This migration contains only plain DDL (no procedures or quoted semicolons).
    for (const command of (await readFile("database/001_crm.sql", "utf8"))
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      await owner.query(command);
  }
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_SOURCE: native ? "postgres" : "demo",
    DATABASE_URL: runtimeUrl,
    APP_ORIGIN: origin,
    TENANT_ID: "szzhhq",
    CSRF_SECRET: "isolated-test-csrf-secret-with-at-least-32-characters",
    PORT: "3106",
  });
  const passwordHash = await hashPassword(qaPassword);
  let app: FastifyInstance;
  const h = {
    db,
    owner,
    get app() {
      return app;
    },
    async reset() {
      if (app) await app.close();
      await owner.query("TRUNCATE crm.tenants CASCADE");
      await owner.query(
        "INSERT INTO crm.tenants(id,name) VALUES ('szzhhq','测试公司'),('other','隔离公司')",
      );
      await owner.query(
        "INSERT INTO crm.teams(id,tenant_id,name) VALUES ($1,'szzhhq','A组'),($2,'szzhhq','B组'),($3,'other','隔离组')",
        [ids.teamA, ids.teamB, ids.outsiderTeam],
      );
      for (const [id, tenant, team, username, role] of [
        [ids.salesA, "szzhhq", ids.teamA, "sales_a", "sales"],
        [ids.salesB, "szzhhq", ids.teamB, "sales_b", "sales"],
        [ids.manager, "szzhhq", ids.teamA, "manager", "manager"],
        [ids.adminA, "szzhhq", null, "admin_a", "admin"],
        [ids.adminB, "szzhhq", null, "admin_b", "admin"],
        [ids.outsider, "other", ids.outsiderTeam, "outsider", "sales"],
      ])
        await owner.query(
          "INSERT INTO crm.users(id,tenant_id,team_id,username,display_name,role,password_hash,must_change_password) VALUES($1,$2,$3,$4,$4,$5,$6,false)",
          [id, tenant, team, username, role, passwordHash],
        );
      app = await createApp({ db, config });
      await app.ready();
    },
    async restart() {
      await app.close();
      app = await createApp({ db, config });
      await app.ready();
    },
    async login(username: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: { username, password: qaPassword },
      });
      expect(response.statusCode, response.body).toBe(200);
      const header = response.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)!.split(
        ";",
      )[0];
      const csrfResponse = await app.inject({
        method: "GET",
        url: "/api/v1/auth/csrf",
        headers: { cookie },
      });
      expect(csrfResponse.statusCode, csrfResponse.body).toBe(200);
      const csrf = csrfResponse.json().data.token as string;
      return {
        cookie,
        csrf,
        request(method: string, path: string, body?: unknown, key?: string) {
          const options: InjectOptions = {
            method: method as InjectOptions["method"],
            url: "/api/v1" + path,
            headers: {
              cookie,
              origin,
              "x-csrf-token": csrf,
              "idempotency-key": key ?? randomUUID(),
            },
          };
          if (body !== undefined)
            options.payload = body as InjectOptions["payload"];
          return app.inject(options);
        },
      };
    },
    async close() {
      if (app) await app.close();
      await db.close();
      await superClient?.end();
    },
  } satisfies Harness;
  return h;
}
export function success(
  response: { statusCode: number; body: string; json: () => any },
  status = 200,
): any {
  expect(response.statusCode, response.body).toBe(status);
  const payload = response.json();
  expect(payload.meta.requestId).toBeTruthy();
  expect(payload.meta.serverTime).toBeTruthy();
  return payload.data;
}
export function customerPayload(name = "测试客户") {
  return { name, phone: "13800000000", source: "call", contact: "测试联系人" };
}
export function activityPayload(name = "测试接触") {
  return {
    type: "call",
    customerName: name,
    phone: "13800000000",
    result: "contact_added",
    nextJudge: "revisit",
  };
}
