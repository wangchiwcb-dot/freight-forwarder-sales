import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

// Run with --config /private/path/live-check.json (mode 0600).
// { baseUrl: "https://sales.example.com", accounts: [
//   { username: "acceptance-user", password: "...", role: "sales", mustChangePassword: true }
// ] }
// Never commits credentials, changes passwords, or writes business records.
const configSchema = z
  .object({
    baseUrl: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      } catch {
        return false;
      }
    }),
    accounts: z
      .array(
        z
          .object({
            username: z.string().trim().min(1).max(100),
            password: z.string().min(1).max(128),
            role: z.enum(["sales", "manager", "admin"]),
            mustChangePassword: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type LiveConfig = z.infer<typeof configSchema>;
type Json = Record<string, any>;
type Transport = typeof fetch;
class VerificationFailure extends Error {
  constructor(readonly step: string) {
    super("Verification failed: " + step);
  }
}
function check(condition: unknown, step: string): asserts condition {
  if (!condition) throw new VerificationFailure(step);
}
export async function readPrivateConfig(path: string): Promise<LiveConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    check(
      info.isFile() && (info.mode & 0o777) === 0o600 && info.size <= 128 * 1024,
      "private config permissions or size",
    );
    check(
      !process.getuid || info.uid === process.getuid(),
      "private config ownership",
    );
    const result = configSchema.safeParse(
      JSON.parse(await file.readFile("utf8")),
    );
    check(result.success, "private config format");
    check(
      new Set(result.data.accounts.map((a) => a.username.toLowerCase()))
        .size === result.data.accounts.length,
      "duplicate configured account",
    );
    return result.data;
  } finally {
    await file.close();
  }
}
interface Session {
  index: number;
  expected: LiveConfig["accounts"][number];
  cookie: string;
  csrf?: string;
  user?: Json;
  customers?: Json[];
  activities?: Json[];
}
export async function verifyLive(
  config: LiveConfig,
  transport: Transport = fetch,
) {
  check(configSchema.safeParse(config).success, "config format");
  check(
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    "TLS verification must be enabled",
  );
  const sessions: Session[] = [];
  const report = {
    requestCount: 0,
    htmlPages: 0,
    brandAssets: 0,
    builtAssets: 0,
    forcedPasswordAccounts: 0,
    fullRoleAccounts: 0,
    rolesChecked: [] as string[],
    ownDetailsChecked: 0,
    forbiddenDetailsChecked: 0,
    foreignOwnerQueriesRejected: 0,
    sessionsRevoked: 0,
    recordIsolation: "not_sampled" as "not_sampled" | "sampled",
  };
  async function request(
    path: string,
    step: string,
    session?: Session,
    body?: unknown,
  ): Promise<Response> {
    check(
      path.startsWith("/") && !path.startsWith("//"),
      "same origin request path",
    );
    const method = body === undefined ? "GET" : "POST";
    check(
      method === "GET" ||
        path === "/api/v1/auth/login" ||
        path === "/api/v1/auth/logout",
      "only login and logout may use POST",
    );
    const headers: Record<string, string> = { Accept: "application/json" };
    if (session) headers.Cookie = session.cookie;
    if (body !== undefined) {
      headers.Origin = config.baseUrl;
      headers["Content-Type"] = "application/json";
      if (session?.csrf) headers["X-CSRF-Token"] = session.csrf;
    }
    report.requestCount++;
    try {
      return await transport(config.baseUrl + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new VerificationFailure(step + " transport");
    }
  }
  async function json(
    path: string,
    step: string,
    session?: Session,
    status = 200,
    code?: string,
    body?: unknown,
  ): Promise<Json> {
    const response = await request(path, step, session, body);
    check(response.status === status, step + " HTTP status");
    let value: Json;
    try {
      value = (await response.json()) as Json;
    } catch {
      throw new VerificationFailure(step + " JSON response");
    }
    if (path.startsWith("/api/")) {
      check(
        value.meta?.requestId && value.meta?.serverTime,
        step + " response metadata",
      );
      check(
        /no-store/i.test(response.headers.get("cache-control") ?? ""),
        step + " response cache policy",
      );
    }
    if (code) check(value.error?.code === code, step + " error code");
    return value;
  }
  async function assets() {
    const built = new Set<string>();
    for (const path of ["/", "/customers", "/leads", "/call-records"]) {
      const step = "HTML page " + path;
      report.requestCount++;
      let response: Response;
      try {
        response = await transport(config.baseUrl + path, {
          headers: { Accept: "text/html" },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new VerificationFailure(step + " transport");
      }
      check(
        response.status === 200 &&
          /text\/html/i.test(response.headers.get("content-type") ?? ""),
        step,
      );
      const html = await response.text();
      check(/id=["']root["']/.test(html), step + " application shell");
      const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((p) => p.startsWith("/assets/"));
      check(
        refs.some((p) => /\.js(?:\?|$)/.test(p)),
        step + " compiled entry",
      );
      refs.forEach((p) => built.add(p));
      report.htmlPages++;
    }
    for (const path of built) {
      const response = await request(path, "compiled asset");
      check(response.status === 200, "compiled asset HTTP status");
      const mime = response.headers.get("content-type") ?? "";
      check(
        /\.css(?:\?|$)/.test(path)
          ? /text\/css/i.test(mime)
          : /javascript/i.test(mime),
        "compiled asset type",
      );
      check(
        (await response.arrayBuffer()).byteLength > 0,
        "compiled asset content",
      );
      report.builtAssets++;
    }
    for (const path of [
      "/brand/zhhq-logo.png",
      "/brand/favicon.png",
      "/brand/apple-touch-icon.png",
    ]) {
      const response = await request(path, "brand asset");
      check(
        response.status === 200 &&
          /image\/png/i.test(response.headers.get("content-type") ?? ""),
        "brand asset HTTP status and type",
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      check(
        bytes.length > 8 &&
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        "brand PNG signature",
      );
      report.brandAssets++;
    }
  }
  async function page(path: string, step: string, session: Session) {
    const result = await json(path, step, session);
    check(
      Array.isArray(result.data) &&
        Number.isInteger(result.meta?.total) &&
        result.meta.total >= result.data.length,
      step + " pagination",
    );
    return result.data as Json[];
  }
  async function verifyAccount(session: Session) {
    const step = "account " + session.index;
    const me = (await json("/api/v1/auth/me", step + " identity", session))
      .data;
    check(
      me?.id &&
        me.role === session.expected.role &&
        me.mustChangePassword === session.expected.mustChangePassword &&
        me.source === "postgres",
      step + " expected identity state",
    );
    session.user = me;
    session.csrf = (await json("/api/v1/auth/csrf", step + " CSRF", session))
      .data?.token;
    check(
      typeof session.csrf === "string" && session.csrf.length >= 32,
      step + " CSRF token",
    );
    if (me.mustChangePassword) {
      for (const path of [
        "/metadata",
        "/dashboard",
        "/customers",
        "/activities",
        "/activities/summary",
        "/assignees",
        "/users",
        "/teams",
      ])
        await json(
          "/api/v1" + path,
          step + " mandatory password gate",
          session,
          403,
          "PASSWORD_CHANGE_REQUIRED",
        );
      report.forcedPasswordAccounts++;
      return;
    }
    const metadata = (
      await json("/api/v1/metadata", step + " metadata", session)
    ).data;
    check(
      metadata?.timeZone === "Asia/Shanghai" &&
        metadata.statuses?.added &&
        metadata.sources?.call,
      step + " metadata contract",
    );
    session.customers = await page(
      "/api/v1/customers?scope=mine&pageSize=100",
      step + " own customers",
      session,
    );
    session.activities = await page(
      "/api/v1/activities?scope=mine&pageSize=100",
      step + " own activities",
      session,
    );
    for (const [kind, rows] of [
      ["customers", session.customers],
      ["activities", session.activities],
    ] as const) {
      check(
        rows.every((row) => row.ownerId === me.id),
        step + " owner isolation",
      );
      if (rows[0]) {
        const result = (
          await json(
            `/api/v1/${kind}/${encodeURIComponent(rows[0].id)}`,
            step + " own detail",
            session,
          )
        ).data;
        check(
          result?.id === rows[0].id && result.ownerId === me.id,
          step + " own detail identity",
        );
        report.ownDetailsChecked++;
      }
    }
    const dashboard = (
      await json(
        "/api/v1/dashboard?scope=mine",
        step + " own dashboard",
        session,
      )
    ).data;
    check(
      dashboard?.scope === "mine" &&
        dashboard.timeZone === "Asia/Shanghai" &&
        dashboard.shipmentVolume?.dataStatus === "not_connected",
      step + " dashboard contract",
    );
    const summary = (
      await json(
        "/api/v1/activities/summary?scope=mine",
        step + " activity summary",
        session,
      )
    ).data;
    check(
      ["total", "calls", "visits", "contactAdded"].every(
        (key) => Number.isInteger(summary?.[key]) && summary[key] >= 0,
      ),
      step + " summary contract",
    );
    const assignees = (
      await json("/api/v1/assignees", step + " assignees", session)
    ).data;
    check(Array.isArray(assignees), step + " assignee contract");
    if (me.role === "sales")
      check(
        assignees.every((row) => row.id === me.id),
        step + " assignee isolation",
      );
    if (me.role === "manager")
      check(
        assignees.every((row) => row.teamId === me.teamId),
        step + " team assignee isolation",
      );
    for (const scope of ["team", "company"]) {
      const allowed =
        scope === "company"
          ? me.role === "admin"
          : me.role !== "sales" && !!me.teamId;
      for (const endpoint of [
        "customers",
        "activities",
        "activities/summary",
        "dashboard",
      ])
        await json(
          `/api/v1/${endpoint}?scope=${scope}`,
          step + " scope " + scope,
          session,
          allowed ? 200 : 403,
          allowed ? undefined : "FORBIDDEN",
        );
    }
    for (const kind of ["users", "teams"]) {
      if (me.role === "admin") {
        const rows = await page(
          `/api/v1/${kind}?pageSize=100`,
          step + " administration list",
          session,
        );
        if (rows[0]) {
          const item = (
            await json(
              `/api/v1/${kind}/${encodeURIComponent(rows[0].id)}`,
              step + " administration detail",
              session,
            )
          ).data;
          check(
            item?.id === rows[0].id && Number.isInteger(item.version),
            step + " administration detail contract",
          );
          check(
            !("passwordHash" in item) &&
              !("password_hash" in item) &&
              !("sessionVersion" in item),
            step + " private identity fields",
          );
        }
      } else {
        await json(
          `/api/v1/${kind}`,
          step + " administration denial",
          session,
          403,
          "FORBIDDEN",
        );
        const id = kind === "users" ? me.id : me.teamId;
        if (id)
          await json(
            `/api/v1/${kind}/${encodeURIComponent(id)}`,
            step + " administration detail denial",
            session,
            403,
            "FORBIDDEN",
          );
      }
    }
    report.fullRoleAccounts++;
    if (!report.rolesChecked.includes(me.role))
      report.rolesChecked.push(me.role);
  }
  let failure: unknown;
  try {
    check(
      (await json("/health/live", "liveness")).status === "ok",
      "liveness contract",
    );
    const ready = await json("/health/ready", "readiness");
    check(
      ready.status === "ok" && ready.source === "postgres",
      "PostgreSQL readiness",
    );
    await assets();
    await json(
      "/api/v1/auth/me",
      "anonymous identity denial",
      undefined,
      401,
      "SESSION_EXPIRED",
    );
    for (const [index, expected] of config.accounts.entries()) {
      const response = await request(
        "/api/v1/auth/login",
        "account login",
        undefined,
        { username: expected.username, password: expected.password },
      );
      check(
        response.status === 200,
        "account " + (index + 1) + " login status",
      );
      const values = response.headers.getSetCookie();
      const cookie = values.find((value) =>
        value.startsWith("__Host-sales_workbench="),
      );
      check(cookie, "production session cookie");
      const session: Session = {
        index: index + 1,
        expected,
        cookie: cookie.split(";", 1)[0],
      };
      sessions.push(session);
      check(
        /;\s*Secure(?:;|$)/i.test(cookie) &&
          /;\s*HttpOnly(?:;|$)/i.test(cookie) &&
          /;\s*SameSite=Strict(?:;|$)/i.test(cookie) &&
          /;\s*Path=\/(?:;|$)/i.test(cookie) &&
          !/;\s*Domain=/i.test(cookie),
        "production session cookie flags",
      );
      await verifyAccount(session);
    }
    for (const actor of sessions.filter(
      (s) => !s.expected.mustChangePassword && s.expected.role !== "admin",
    )) {
      for (const peer of sessions.filter(
        (s) => s.user?.id !== actor.user?.id,
      )) {
        const scope = actor.expected.role === "sales" ? "mine" : "team";
        const hidden =
          scope === "mine" || peer.user?.teamId !== actor.user?.teamId;
        if (!hidden) continue;
        for (const kind of [
          "customers",
          "activities",
          "activities/summary",
          "dashboard",
        ])
          await json(
            `/api/v1/${kind}?scope=${scope}&ownerId=${encodeURIComponent(peer.user!.id)}`,
            "foreign owner scope denial",
            actor,
            403,
            "FORBIDDEN",
          );
        report.foreignOwnerQueriesRejected += 4;
        for (const [kind, rows] of [
          ["customers", peer.customers],
          ["activities", peer.activities],
        ] as const) {
          if (rows?.[0]) {
            await json(
              `/api/v1/${kind}/${encodeURIComponent(rows[0].id)}`,
              "foreign detail denial",
              actor,
              404,
              "NOT_FOUND",
            );
            report.forbiddenDetailsChecked++;
          }
        }
      }
    }
    report.recordIsolation = report.forbiddenDetailsChecked
      ? "sampled"
      : "not_sampled";
  } catch (error) {
    failure = error;
  } finally {
    for (const session of sessions) {
      try {
        if (!session.csrf)
          session.csrf = (
            await json("/api/v1/auth/csrf", "cleanup CSRF", session)
          ).data?.token;
        check(session.csrf, "cleanup CSRF token");
        check(
          (
            await json(
              "/api/v1/auth/logout",
              "session logout",
              session,
              200,
              undefined,
              {},
            )
          ).data?.loggedOut === true,
          "logout result",
        );
        await json(
          "/api/v1/auth/me",
          "session revoked",
          session,
          401,
          "SESSION_EXPIRED",
        );
        report.sessionsRevoked++;
      } catch {
        failure ??= new VerificationFailure("session cleanup or revocation");
      }
    }
  }
  if (failure) throw failure;
  return report;
}
async function main() {
  try {
    const args = process.argv.slice(2);
    check(
      args.length === 2 && args[0] === "--config" && args[1],
      "provide --config with a protected JSON file",
    );
    const report = await verifyLive(await readPrivateConfig(args[1]));
    console.log(JSON.stringify({ status: "passed", ...report }));
    if (report.recordIsolation === "not_sampled")
      console.log(
        "Record-level isolation was not sampled: no eligible existing peer records. No business records were created.",
      );
    if (!report.fullRoleAccounts)
      console.log(
        "Only first-password-change accounts were checked. Full role checks require separate staging accounts.",
      );
  } catch (error) {
    console.error(
      error instanceof VerificationFailure
        ? error.message
        : "Verification failed: private config or response could not be read.",
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main();
