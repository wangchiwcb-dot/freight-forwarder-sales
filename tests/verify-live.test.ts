import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import {
  readPrivateConfig,
  verifyLive,
  type LiveConfig,
} from "../scripts/verify-live.js";
import {
  createHarness,
  customerPayload,
  activityPayload,
  qaPassword,
  success,
  type Harness,
} from "./support/harness.js";

const baseUrl = "https://acceptance.example.test";
const account = (
  username: string,
  role: "sales" | "manager" | "admin",
  mustChangePassword = false,
) => ({ username, password: qaPassword, role, mustChangePassword });
describe("Read-only live acceptance verifier", () => {
  let h: Harness | undefined, app: FastifyInstance | undefined;
  const directories: string[] = [];
  afterEach(async () => {
    await app?.close();
    await h?.close();
    app = undefined;
    h = undefined;
    for (const path of directories.splice(0))
      await rm(path, { recursive: true, force: true });
  });
  async function setup() {
    h = await createHarness();
    await h.reset();
    const config = loadConfig({
      NODE_ENV: "production",
      DATA_SOURCE: "postgres",
      DATABASE_URL: "postgresql://unused@127.0.0.1/sales_workbench_test",
      APP_ORIGIN: baseUrl,
      CSRF_SECRET: "isolated-acceptance-test-secret-at-least-32-characters",
    });
    app = await createApp({ db: h.db, config });
    app.log.level = "silent";
    await app.ready();
    const calls: { method: string; path: string }[] = [];
    let failMetadata = false;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname });
      expect(url.origin).toBe(baseUrl);
      expect(init?.redirect).toBe("error");
      if (["/", "/customers", "/leads", "/call-records"].includes(url.pathname))
        return new Response(
          '<html><div id="root"></div><script src="/assets/app.js"></script><link href="/assets/app.css"></html>',
          { headers: { "content-type": "text/html" } },
        );
      if (url.pathname.startsWith("/brand/"))
        return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), {
          headers: { "content-type": "image/png" },
        });
      if (url.pathname === "/assets/app.js")
        return new Response("export {};", {
          headers: { "content-type": "application/javascript" },
        });
      if (url.pathname === "/assets/app.css")
        return new Response("body{}", {
          headers: { "content-type": "text/css" },
        });
      if (failMetadata && url.pathname === "/api/v1/metadata")
        return new Response("{}", { status: 503 });
      const result = await app!.inject({
        method: method as InjectOptions["method"],
        url: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers))
        if (value !== undefined)
          for (const item of Array.isArray(value) ? value : [value])
            headers.append(name, String(item));
      return new Response(result.body, { status: result.statusCode, headers });
    };
    return {
      calls,
      transport,
      failMetadata() {
        failMetadata = true;
      },
    };
  }
  it("verifies first-password-change accounts without modifying a password or business record", async () => {
    const fixture = await setup();
    await h!.owner.query(
      "UPDATE crm.users SET must_change_password=true WHERE username='sales_a'",
    );
    const report = await verifyLive(
      { baseUrl, accounts: [account("sales_a", "sales", true)] },
      fixture.transport,
    );
    expect(report).toMatchObject({
      htmlPages: 4,
      brandAssets: 3,
      builtAssets: 2,
      forcedPasswordAccounts: 1,
      fullRoleAccounts: 0,
      sessionsRevoked: 1,
      recordIsolation: "not_sampled",
    });
    expect(
      fixture.calls
        .filter((call) => call.method !== "GET")
        .map((call) => call.path),
    ).toEqual(["/api/v1/auth/login", "/api/v1/auth/logout"]);
    expect(
      (
        await h!.owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM crm.customers",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await h!.owner.query<{ flag: boolean }>(
          "SELECT must_change_password AS flag FROM crm.users WHERE username='sales_a'",
        )
      ).rows[0].flag,
    ).toBe(true);
  });
  it("checks sales, manager and admin scopes using existing synthetic peer records only", async () => {
    const fixture = await setup();
    for (const username of ["sales_a", "sales_b"]) {
      const actor = await h!.login(username);
      success(
        await actor.request("POST", "/customers", customerPayload()),
        201,
      );
      success(
        await actor.request("POST", "/activities", activityPayload()),
        201,
      );
    }
    const report = await verifyLive(
      {
        baseUrl,
        accounts: [
          account("sales_a", "sales"),
          account("sales_b", "sales"),
          account("manager", "manager"),
          account("admin_a", "admin"),
        ],
      },
      fixture.transport,
    );
    expect(report).toMatchObject({
      fullRoleAccounts: 4,
      forcedPasswordAccounts: 0,
      sessionsRevoked: 4,
      recordIsolation: "sampled",
    });
    expect(report.rolesChecked).toEqual(["sales", "manager", "admin"]);
    expect(report.forbiddenDetailsChecked).toBeGreaterThan(0);
    expect(report.foreignOwnerQueriesRejected).toBeGreaterThan(0);
    expect(
      fixture.calls.every(
        (call) =>
          call.method === "GET" ||
          ["/api/v1/auth/login", "/api/v1/auth/logout"].includes(call.path),
      ),
    ).toBe(true);
    expect(
      (
        await h!.owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM crm.customers",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("revokes the acceptance session even when a verification step fails", async () => {
    const fixture = await setup();
    fixture.failMetadata();
    await expect(
      verifyLive(
        { baseUrl, accounts: [account("sales_a", "sales")] },
        fixture.transport,
      ),
    ).rejects.toThrow("metadata HTTP status");
    expect(
      fixture.calls.some((call) => call.path === "/api/v1/auth/logout"),
    ).toBe(true);
    expect(
      (
        await h!.owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM crm.sessions WHERE revoked_at IS NULL",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("requires an owner-only regular configuration file and rejects symlinks or HTTP targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sales-live-config-test-"));
    directories.push(dir);
    const path = join(dir, "config.json"),
      config: LiveConfig = {
        baseUrl,
        accounts: [account("sales_a", "sales", true)],
      };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect(await readPrivateConfig(path)).toEqual(config);
    const link = join(dir, "link.json");
    await symlink(path, link);
    await expect(readPrivateConfig(link)).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(readPrivateConfig(path)).rejects.toThrow("permissions");
    await expect(
      verifyLive({ ...config, baseUrl: "http://acceptance.example.test" }),
    ).rejects.toThrow("config format");
  });
});
