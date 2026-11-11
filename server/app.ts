import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { metadata } from "../shared/contracts.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { ApiError, type Row } from "./core.js";
import { registerAuth } from "./auth.js";
import { registerBusiness } from "./business.js";
import { registerAdministration } from "./administration.js";

export async function createApp({
  db,
  config,
}: {
  db: Database;
  config: Config;
}) {
  const app = Fastify({
    logger: { level: config.production ? "info" : "error" },
    disableRequestLogging: true,
    trustProxy: ["127.0.0.1", "::1"],
    bodyLimit: 65536,
    requestTimeout: 30000,
  });
  app.addHook("onResponse", async (request, reply) => {
    app.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        elapsedMs: reply.elapsedTime,
      },
      "request completed",
    );
  });
  const meta = (request: FastifyRequest) => ({
    requestId: request.id,
    serverTime: new Date().toISOString(),
  });
  const send = (request: FastifyRequest, data: unknown, extra: Row = {}) => ({
    data,
    meta: { ...meta(request), ...extra },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    global: true,
    hook: "preHandler",
    max: 300,
    timeWindow: "1 minute",
    allowList: (request) => !request.url.startsWith("/api/"),
    keyGenerator: (request) =>
      request.user
        ? `user:${request.user.tenant_id}:${request.user.id}`
        : `ip:${request.ip}`,
    errorResponseBuilder: () =>
      new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试"),
  });
  app.setErrorHandler(
    (error: Error & { code?: string; statusCode?: number }, request, reply) => {
      if (error instanceof ApiError)
        return reply.code(error.status).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          },
          meta: meta(request),
        });
      if (error.code === "23505")
        return reply.code(409).send({
          error: { code: "DUPLICATE", message: "记录已存在，请刷新后检查" },
          meta: meta(request),
        });
      if (["23503", "23514", "22001", "22P02"].includes(error.code ?? ""))
        return reply.code(422).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "数据不符合业务约束，请检查后重试",
          },
          meta: meta(request),
        });
      if (["40P01", "40001", "55P03"].includes(error.code ?? ""))
        return reply.code(409).send({
          error: {
            code: "RETRY_TRANSACTION",
            message: "数据正在更新，请保留内容后重试",
          },
          meta: meta(request),
        });
      const status =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 503;
      if (status === 503)
        app.log.error(
          {
            requestId: request.id,
            errorCode: error.code ?? "INTERNAL",
            route: request.routeOptions.url,
          },
          "request failed",
        );
      return reply.code(status).send({
        error: {
          code:
            status === 429
              ? "RATE_LIMITED"
              : status === 400
                ? "BAD_REQUEST"
                : status === 413
                  ? "BODY_TOO_LARGE"
                  : "SERVICE_UNAVAILABLE",
          message:
            status === 503
              ? "服务暂时不可用，请稍后重试"
              : "请求无效，请检查后重试",
        },
        meta: meta(request),
      });
    },
  );
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const r = await db.query<Row>(
        "SELECT max(version) AS version FROM crm.migrations",
      );
      if (Number(r.rows[0]?.version) !== 1) throw new Error("schema");
      return { status: "ok", source: config.source };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  await registerAuth(app, db, config, send);
  app.get("/api/v1/metadata", (request) => send(request, metadata));
  await registerBusiness(app, db, send);
  await registerAdministration(app, db, config, send);
  if (config.staticDir) {
    if (!existsSync(join(config.staticDir, "index.html")))
      throw new Error("Static build not found");
    await app.register(staticPlugin, {
      root: config.staticDir,
      wildcard: false,
      setHeaders(res, path) {
        res.header(
          "Cache-Control",
          path.endsWith("index.html")
            ? "no-cache"
            : /\/assets\//.test(path)
              ? "public, max-age=31536000, immutable"
              : "no-cache",
        );
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      config.staticDir &&
      request.method === "GET" &&
      !request.url.startsWith("/api/") &&
      !request.url.startsWith("/health/") &&
      !request.url.startsWith("/assets/") &&
      request.headers.accept?.includes("text/html")
    )
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: "页面或接口不存在" },
      meta: meta(request),
    });
  });
  return app;
}
