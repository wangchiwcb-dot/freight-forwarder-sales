import { resolve } from "node:path";

export interface Config {
  source: "demo" | "postgres";
  production: boolean;
  origin: string;
  tenantId: string;
  csrfSecret: string;
  host: string;
  port: number;
  staticDir?: string;
  databaseUrl?: string;
  demoPath?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const source = env.DATA_SOURCE ?? (production ? "postgres" : "demo");
  if (source !== "demo" && source !== "postgres")
    throw new Error("DATA_SOURCE must be demo or postgres");
  if (production && source !== "postgres")
    throw new Error("Production requires PostgreSQL");
  const origin = env.APP_ORIGIN ?? "http://127.0.0.1:4193";
  if (
    new URL(origin).origin !== origin ||
    (production && !origin.startsWith("https://"))
  )
    throw new Error(
      "APP_ORIGIN must be an exact origin, with HTTPS in production",
    );
  const csrfSecret =
    env.CSRF_SECRET ??
    (production ? "" : "local-demo-only-csrf-secret-not-for-production");
  if (csrfSecret.length < 32)
    throw new Error("CSRF_SECRET must contain at least 32 characters");
  if (source === "postgres" && !env.DATABASE_URL)
    throw new Error("DATABASE_URL is required");
  const host = env.HOST ?? "127.0.0.1";
  if (production && host !== "127.0.0.1" && host !== "::1")
    throw new Error("Production must listen on loopback");
  const port = Number(env.PORT ?? 3106);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  return {
    production,
    source,
    origin,
    csrfSecret,
    host,
    port,
    tenantId: env.TENANT_ID ?? "szzhhq",
    databaseUrl: env.DATABASE_URL,
    demoPath: env.DEMO_DB_PATH ?? ".data/demo-db",
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : undefined,
  };
}
