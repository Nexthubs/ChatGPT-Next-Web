/** @jest-environment node */
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import {
  checkExternalAuth,
  withExternalAuth,
} from "../app/utils/external-auth";
import { middleware } from "../middleware";

const upstream = jest.mocked(global.fetch);
const originalCheck = process.env.AUTH_CHECK_URL;
const originalRedirect = process.env.AUTH_REDIRECT_URL;
const request = (
  path = "/",
  cookie = "wordpress_logged_in_test=session",
  method = "GET",
) =>
  new NextRequest(`https://chat.example.com${path}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {},
  });
const reply = (body: unknown, status = 200) => {
  upstream.mockResolvedValue(new Response(JSON.stringify(body), { status }));
};

beforeEach(() => {
  process.env.AUTH_CHECK_URL = "https://flow.example.com/auth-check.php";
  process.env.AUTH_REDIRECT_URL = "https://ai.example.com/";
  upstream.mockReset();
});

afterAll(() => {
  if (originalCheck === undefined) delete process.env.AUTH_CHECK_URL;
  else process.env.AUTH_CHECK_URL = originalCheck;
  if (originalRedirect === undefined) delete process.env.AUTH_REDIRECT_URL;
  else process.env.AUTH_REDIRECT_URL = originalRedirect;
});

test.each([false, "true", 1, null, undefined])(
  "logged_in=%s is rejected even with HTTP 200",
  async (logged_in) => {
    reply({ logged_in });
    expect((await checkExternalAuth(request())).status).toBe("unauthenticated");
  },
);

test("forwards only the cookie to the configured server and never follows redirects or caches auth", async () => {
  reply({ logged_in: true, user: { id: 7 } });
  const req = request();
  req.headers.set("Authorization", "Bearer untrusted");
  req.headers.set("X-Auth-User", "administrator");
  expect(await checkExternalAuth(req)).toEqual({
    status: "authenticated",
    userId: "7",
  });
  expect(upstream).toHaveBeenCalledWith(
    new URL(process.env.AUTH_CHECK_URL!),
    expect.objectContaining({
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      headers: {
        Cookie: "wordpress_logged_in_test=session",
        Accept: "application/json",
      },
    }),
  );
});

test("forged identity or a bearer key without cookies does not establish a login", async () => {
  const req = request("/", "");
  req.headers.set("X-Auth-User", "1");
  req.headers.set("Authorization", "Bearer fake");
  expect((await checkExternalAuth(req)).status).toBe("unauthenticated");
  expect(upstream).not.toHaveBeenCalled();
});

test.each([302, 500])("auth HTTP %i fails closed", async (status) => {
  reply({ logged_in: true }, status);
  expect((await checkExternalAuth(request())).status).toBe("unavailable");
});

test("invalid JSON and network failures fail closed", async () => {
  upstream.mockResolvedValueOnce(new Response("<html>login</html>"));
  expect((await checkExternalAuth(request())).status).toBe("unavailable");
  upstream.mockRejectedValueOnce(new Error("offline"));
  expect((await checkExternalAuth(request())).status).toBe("unavailable");
});

test("auth timeout aborts and fails closed", async () => {
  jest.useFakeTimers();
  try {
    upstream.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const result = checkExternalAuth(request());
    await jest.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe("unavailable");
  } finally {
    jest.useRealTimers();
  }
});

test("bad auth URL cannot enable access or forward cookies over HTTP", async () => {
  process.env.AUTH_CHECK_URL = "http://flow.example.com/auth-check.php";
  expect((await checkExternalAuth(request())).status).toBe("unavailable");
  expect(upstream).not.toHaveBeenCalled();
});

test("anonymous pages redirect to the fixed login URL with no-store", async () => {
  const response = await middleware(
    request("/?redirect=https://evil.example", ""),
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://ai.example.com/");
  expect(response.headers.get("cache-control")).toContain("no-store");
});

test.each(["/api/auth-gate", "/api/auth-check/"])(
  "Caddy probe %s translates PHP JSON into status codes",
  async (path) => {
    reply({ logged_in: false });
    expect((await middleware(request(path))).status).toBe(401);
    reply({ logged_in: true, user: { id: 7 }, logout_url: "private" });
    const response = await middleware(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-auth-user")).toBe("7");
    expect(await response.json()).toEqual({ logged_in: true });
  },
);

test("a broken auth service returns 503 instead of allowing a page", async () => {
  upstream.mockRejectedValue(new Error("offline"));
  expect((await middleware(request())).status).toBe(503);
});

test("external rewrites require login and file-like URLs do not bypass auth", async () => {
  expect(
    (await middleware(request("/api/proxy/openai/v1/models", ""))).status,
  ).toBe(401);
  expect((await middleware(request("/private.json", ""))).status).toBe(307);
  expect((await middleware(request("/", "", "POST"))).status).toBe(401);
});

test("immutable framework GET assets remain available", async () => {
  expect(
    (await middleware(request("/_next/static/chunks/app.js", ""))).headers.get(
      "x-middleware-next",
    ),
  ).toBe("1");
  expect(upstream).not.toHaveBeenCalled();
});

test("direct API calls are denied before business handlers even without middleware or Caddy", async () => {
  const business = jest.fn(
    async (_req: NextRequest) => new Response("model called"),
  );
  const handler = withExternalAuth(business);
  expect(
    (await handler(request("/api/openai/v1/chat/completions", "", "POST")))
      .status,
  ).toBe(401);
  expect(business).not.toHaveBeenCalled();
  upstream.mockRejectedValue(new Error("offline"));
  expect(
    (await handler(request("/api/openai/v1/chat/completions"))).status,
  ).toBe(503);
  expect(business).not.toHaveBeenCalled();
  reply({ logged_in: true });
  const response = await handler(request("/api/openai/v1/chat/completions"));
  expect(await response.text()).toBe("model called");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(business).toHaveBeenCalledTimes(1);
});

test("legacy mode stays available without AUTH_CHECK_URL, but Caddy probes fail closed", async () => {
  delete process.env.AUTH_CHECK_URL;
  expect(
    (await middleware(request("/", ""))).headers.get("x-middleware-next"),
  ).toBe("1");
  expect((await middleware(request("/api/auth-gate", ""))).status).toBe(503);
});
