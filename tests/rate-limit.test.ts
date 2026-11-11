import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  origin,
  qaPassword,
  success,
  type Harness,
} from "./support/harness.js";

describe("Per-user API limits behind a shared company IP", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await h.reset();
  });
  afterAll(async () => {
    await h?.close();
  });

  function expectLimited(response: {
    statusCode: number;
    body: string;
    json: () => any;
    headers: Record<string, unknown>;
  }) {
    expect(response.statusCode, response.body).toBe(429);
    const payload = response.json();
    expect(payload.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(payload.error.message).toBeTruthy();
    expect(payload.meta.requestId).toBeTruthy();
    expect(Number.isNaN(Date.parse(payload.meta.serverTime))).toBe(false);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }

  it("does not charge health or non-API static paths against the API quota", async () => {
    const sales = await h.login("sales_a");
    const before = await sales.request("GET", "/auth/me");
    success(before);
    for (let i = 0; i < 305; i++) {
      for (const [path, status] of [
        ["/health/live", 200],
        ["/health/ready", 200],
        ["/assets/missing-test-bundle.js", 404],
      ] as const) {
        const response = await h.app.inject({
          method: "GET",
          url: path,
          headers: { cookie: sales.cookie },
        });
        expect(response.statusCode, response.body).toBe(status);
      }
    }
    const after = await sales.request("GET", "/auth/me");
    success(after);
    expect(Number(after.headers["x-ratelimit-remaining"])).toBe(
      Number(before.headers["x-ratelimit-remaining"]) - 1,
    );
  });

  it("returns a proper 429 after one employee exhausts 300 requests while a colleague on the same IP remains usable", async () => {
    const first = await h.login("sales_a"),
      colleague = await h.login("sales_b");
    // login() already used one authenticated request to fetch the CSRF token.
    for (let i = 0; i < 299; i++)
      success(await first.request("GET", "/auth/me"));
    expectLimited(await first.request("GET", "/auth/me"));
    expectLimited(await first.request("GET", "/metadata"));
    expect(success(await colleague.request("GET", "/auth/me")).username).toBe(
      "sales_b",
    );
    expect(success(await colleague.request("GET", "/customers"))).toEqual([]);
  });

  it("keeps the ten-attempt login limit for one account and IP with the correct 429 envelope", async () => {
    const login = (username: string, password: string) =>
      h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { origin },
        payload: { username, password },
      });
    for (let i = 0; i < 10; i++) {
      const result = await login("sales_a", "incorrect-test-password");
      expect(result.statusCode, result.body).toBe(401);
      expect(result.json().error.code).toBe("INVALID_CREDENTIALS");
    }
    expectLimited(await login("sales_a", qaPassword));
    expect(success(await login("sales_b", qaPassword)).username).toBe(
      "sales_b",
    );
  });
});
