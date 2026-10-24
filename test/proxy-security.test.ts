/** @jest-environment node */
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";
import { handle } from "../app/api/proxy";

const upstream = jest.mocked(global.fetch);
const originalKey = process.env.OPENAI_API_KEY;
const originalAllowed = process.env.PROXY_ALLOWED_ORIGINS;
const originalHide = process.env.HIDE_USER_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-system-key";
  process.env.HIDE_USER_API_KEY = "1";
  delete process.env.PROXY_ALLOWED_ORIGINS;
  upstream.mockReset();
});
afterAll(() => {
  for (const [key, value] of [
    ["OPENAI_API_KEY", originalKey],
    ["PROXY_ALLOWED_ORIGINS", originalAllowed],
    ["HIDE_USER_API_KEY", originalHide],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function proxy(base: string, path = ["v1", "models"]) {
  return handle(
    new NextRequest("https://chat.example.com/api/custom/" + path.join("/"), {
      headers: { "x-base-url": base },
    }),
    { params: { path } },
  );
}

test.each([
  "https://api.openai.com.attacker.example",
  "https://attacker.example/api.openai.com",
  "https://api.openai.com@attacker.example",
  "https://attacker.example?host=api.openai.com",
  "https://attacker.example#api.openai.com",
  "https://api.openai.com:8443",
  "http://api.openai.com",
  "http://127.0.0.1",
  "http://169.254.169.254",
  "",
])(
  "untrusted destination %s is blocked before any outbound fetch",
  async (base) => {
    expect((await proxy(base)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  },
);

test("the exact OpenAI origin receives the system key only on allowed paths", async () => {
  upstream.mockResolvedValue(new Response("{}"));
  expect((await proxy("https://api.openai.com")).status).toBe(200);
  const [url, options] = upstream.mock.calls[0];
  expect(String(url)).toBe("https://api.openai.com/v1/models");
  expect(new Headers(options!.headers).get("Authorization")).toBe(
    "Bearer test-system-key",
  );
  expect(options!.redirect).toBe("manual");
  upstream.mockClear();
  expect((await proxy("https://api.openai.com", ["v1", "files"])).status).toBe(
    403,
  );
  expect(upstream).not.toHaveBeenCalled();
});

test("administrator-allowed plugin origins never receive the system OpenAI key", async () => {
  process.env.PROXY_ALLOWED_ORIGINS = "https://plugin.example";
  upstream.mockResolvedValue(new Response("{}"));
  expect((await proxy("https://plugin.example")).status).toBe(200);
  const options = upstream.mock.calls[0][1];
  expect(new Headers(options!.headers).has("Authorization")).toBe(false);
});
