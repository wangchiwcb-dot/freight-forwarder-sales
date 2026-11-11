import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import { audit, dto, fail, parse, type Row } from "./core.js";

const derive = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hex] = stored.split(":");
  const valid =
    algorithm === "scrypt" &&
    /^[0-9a-f]{32}$/.test(salt ?? "") &&
    /^[0-9a-f]{128}$/.test(hex ?? "");
  const actual = (await derive(
    password,
    valid ? salt : "00000000000000000000000000000000",
    64,
  )) as Buffer;
  return valid && timingSafeEqual(actual, Buffer.from(hex, "hex"));
}
export const passwordSchema = z
  .string()
  .min(14, "密码至少14位")
  .max(128, "密码最多128位");
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}
export function csrfToken(secret: string, token: string) {
  return createHmac("sha256", secret).update(token).digest("base64url");
}
declare module "fastify" {
  interface FastifyRequest {
    user: Row | null;
    sessionToken: string | null;
  }
}
export function publicUser(row: Row, config: Config) {
  return {
    ...dto({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      team_id: row.team_id,
      team_name: row.team_name ?? null,
      enabled: row.enabled,
      must_change_password: row.must_change_password,
      version: row.version,
    }),
    allowedScopes:
      row.role === "admin"
        ? ["mine", "team", "company"]
        : row.role === "manager"
          ? ["mine", "team"]
          : ["mine"],
    source: config.source,
  };
}
export function cookieName(config: Config) {
  return config.production ? "__Host-sales_workbench" : "sales_workbench";
}
function cookie(config: Config, token: string, clear = false) {
  return `${cookieName(config)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${config.production ? "; Secure" : ""}`;
}
function checkOrigin(request: FastifyRequest, config: Config) {
  if (
    request.headers.origin !== config.origin ||
    request.headers["sec-fetch-site"] === "cross-site"
  )
    fail(403, "ORIGIN_REJECTED", "请求来源不正确，请从工作台页面操作");
}
export async function registerAuth(
  app: FastifyInstance,
  db: Database,
  config: Config,
  send: (request: FastifyRequest, data: unknown) => unknown,
) {
  const failedAccounts = new Map<string, { count: number; until: number }>();
  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = new URL(request.url, "http://local").pathname;
    if (!path.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
      checkOrigin(request, config);
    if (path === "/api/v1/auth/login") return;
    const token = (request.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName(config) + "="))
      ?.slice(cookieName(config).length + 1);
    if (token && /^[A-Za-z0-9_-]{43,128}$/.test(token)) {
      const row = (
        await db.query<Row>(
          `SELECT u.*,t.name AS team_name,s.csrf_hash FROM crm.sessions s JOIN crm.users u ON (s.tenant_id,s.user_id)=(u.tenant_id,u.id) LEFT JOIN crm.teams t ON (u.tenant_id,u.team_id)=(t.tenant_id,t.id) WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.session_version=u.session_version AND u.enabled=true`,
          [hashToken(token), config.tenantId],
        )
      ).rows[0];
      if (row) {
        request.user = row;
        request.sessionToken = token;
      }
    }
    if (!request.user) {
      if (path === "/api/v1/auth/logout") return;
      fail(401, "SESSION_EXPIRED", "请登录后继续");
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      const supplied = request.headers["x-csrf-token"];
      const stored = Buffer.from(request.user!.csrf_hash);
      if (
        typeof supplied !== "string" ||
        stored.length !== 32 ||
        !timingSafeEqual(hashToken(supplied), stored)
      )
        fail(403, "CSRF_REJECTED", "页面验证已失效，请刷新后重试");
    }
    if (
      request.user!.must_change_password &&
      ![
        "/api/v1/auth/me",
        "/api/v1/auth/csrf",
        "/api/v1/auth/change-password",
        "/api/v1/auth/logout",
      ].includes(path)
    )
      fail(403, "PASSWORD_CHANGE_REQUIRED", "请先修改初始密码");
  });
  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (request) =>
            request.ip +
            ":" +
            hashToken(
              String((request.body as Row | undefined)?.username ?? "")
                .trim()
                .toLowerCase(),
            ).toString("hex"),
        },
      },
    },
    async (request, reply) => {
      const input = parse(
        z
          .object({
            username: z.string().trim().min(1).max(100),
            password: z.string().min(1).max(128),
          })
          .strict(),
        request.body,
      );
      const accountKey = hashToken(
        config.tenantId + ":" + input.username.toLowerCase(),
      ).toString("hex");
      const now = Date.now();
      for (const [key, entry] of failedAccounts)
        if (entry.until <= now) failedAccounts.delete(key);
      const attempts = failedAccounts.get(accountKey);
      if (attempts && attempts.count >= 20) {
        reply.header("Retry-After", Math.ceil((attempts.until - now) / 1000));
        fail(429, "RATE_LIMITED", "登录尝试过多，请稍后重试");
      }
      const user = (
        await db.query<Row>(
          "SELECT * FROM crm.users WHERE tenant_id=$1 AND lower(username)=lower($2)",
          [config.tenantId, input.username],
        )
      ).rows[0];
      const valid = await verifyPassword(
        input.password,
        user?.password_hash ?? "",
      );
      if (!valid || !user?.enabled) {
        if (failedAccounts.size < 10000 || attempts)
          failedAccounts.set(accountKey, {
            count: (attempts?.count ?? 0) + 1,
            until: attempts?.until ?? now + 600000,
          });
        fail(401, "INVALID_CREDENTIALS", "账号或密码不正确");
      }
      failedAccounts.delete(accountKey);
      const token = randomBytes(32).toString("base64url");
      await db.transaction(async (tx) => {
        const fresh = (
          await tx.query<Row>(
            "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR SHARE",
            [config.tenantId, user.id],
          )
        ).rows[0];
        if (!fresh.enabled || fresh.password_hash !== user.password_hash)
          fail(401, "INVALID_CREDENTIALS", "账号或密码不正确");
        await tx.query(
          "INSERT INTO crm.sessions(token_hash,tenant_id,user_id,session_version,csrf_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '8 hours')",
          [
            hashToken(token),
            config.tenantId,
            user.id,
            fresh.session_version,
            hashToken(csrfToken(config.csrfSecret, token)),
          ],
        );
        await audit(tx, fresh, request, "user", user.id, "login", {});
      });
      reply.header("Set-Cookie", cookie(config, token));
      return send(request, publicUser(user, config));
    },
  );
  app.get("/api/v1/auth/me", (request) =>
    send(request, publicUser(request.user!, config)),
  );
  app.get("/api/v1/auth/csrf", (request) =>
    send(request, {
      token: csrfToken(config.csrfSecret, request.sessionToken!),
    }),
  );
  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (request.sessionToken)
      await db.query(
        "UPDATE crm.sessions SET revoked_at=now() WHERE token_hash=$1",
        [hashToken(request.sessionToken)],
      );
    reply.header("Set-Cookie", cookie(config, "", true));
    return send(request, { loggedOut: true });
  });
  app.post(
    "/api/v1/auth/change-password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(
        z
          .object({
            currentPassword: z.string().min(1).max(128),
            newPassword: passwordSchema,
          })
          .strict(),
        request.body,
      );
      await db.transaction(async (tx) => {
        const user = (
          await tx.query<Row>(
            "SELECT * FROM crm.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [config.tenantId, request.user!.id],
          )
        ).rows[0];
        if (
          !user.enabled ||
          user.session_version !== request.user!.session_version
        )
          fail(401, "SESSION_EXPIRED", "登录已失效");
        if (!(await verifyPassword(input.currentPassword, user.password_hash)))
          fail(422, "INVALID_PASSWORD", "原密码不正确");
        if (input.currentPassword === input.newPassword)
          fail(422, "INVALID_PASSWORD", "新密码不能与原密码相同");
        const hash = await hashPassword(input.newPassword);
        await tx.query(
          "UPDATE crm.users SET password_hash=$3,must_change_password=false,session_version=session_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [config.tenantId, user.id, hash],
        );
        await tx.query(
          "UPDATE crm.sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [config.tenantId, user.id],
        );
        await audit(tx, user, request, "user", user.id, "change_password", {});
      });
      reply.header("Set-Cookie", cookie(config, "", true));
      return send(request, { changed: true });
    },
  );
}
