import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Envelope } from "./model";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
    public requestId?: string,
  ) {
    super(message);
  }
}
let csrf: string | null = null;
export function resetSession() {
  csrf = null;
}
export function queryString(params: object = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.set(k, String(v));
  });
  return qs.toString();
}
export async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<Envelope<T>> {
  const headers = new Headers(init.headers);
  const method = init.method || "GET";
  if (init.body) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD" && path !== "/auth/login") {
    if (!csrf) {
      const result = await request<{ token: string }>("/auth/csrf");
      csrf = result.data.token;
    }
    headers.set("X-CSRF-Token", csrf);
  }
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK_ERROR", "连接失败，请检查网络后重试。");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") {
      resetSession();
      window.dispatchEvent(new Event("session-expired"));
    }
    throw new ApiError(
      response.status,
      body?.error?.code || "REQUEST_FAILED",
      body?.error?.message || "暂时无法完成请求，请重试。",
      body?.error?.fieldErrors,
      body?.meta?.requestId,
    );
  }
  if (!body || !("data" in body))
    throw new ApiError(502, "INVALID_RESPONSE", "服务响应异常，请重试。");
  return body as Envelope<T>;
}
export function useApi<T>(
  key: readonly unknown[],
  path: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["business", ...key],
    queryFn: ({ signal }) => request<T>(path, { signal }),
    enabled,
    staleTime: 15000,
    retry: (count, error) =>
      count < 2 &&
      (!(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500),
  });
}
export function useWrite() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const previous = useRef({ signature: "", key: "" });
  const busyRef = useRef(false);
  async function write<T>(
    path: string,
    body: unknown = {},
    method = "POST",
    idempotent = false,
  ) {
    if (busyRef.current)
      throw new ApiError(
        409,
        "REQUEST_IN_PROGRESS",
        "当前操作正在保存，请稍候。",
      );
    busyRef.current = true;
    const signature = method + path + JSON.stringify(body);
    if (previous.current.signature !== signature)
      previous.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const result = await request<T>(
        path,
        { method, body: JSON.stringify(body) },
        idempotent ? previous.current.key : undefined,
      );
      previous.current = { signature: "", key: "" };
      await qc.invalidateQueries({ queryKey: ["business"] });
      return result;
    } catch (e) {
      setError(e instanceof Error ? e : new Error("请求失败"));
      throw e;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return { write, busy, error, clearError: () => setError(null) };
}
