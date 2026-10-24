// Run after `yarn build`. Uses a local HTTPS WordPress stub and a production
// Next server; never calls WordPress, model providers, or the public deployment.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(os.tmpdir(), "nextchat-auth-http-"));
let app;
let authServer;
let output = "";
let checks = 0;
try {
  const cert = path.join(temp, "cert.pem");
  const key = path.join(temp, "key.pem");
  const openssl = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    openssl.status,
    0,
    "OpenSSL must create a local test certificate",
  );

  authServer = https.createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "private, no-store");
      const cookie = req.headers.cookie ?? "";
      if (cookie.includes("=down")) {
        res.writeHead(500).end("{}");
      } else if (cookie.includes("=malformed")) {
        res.end("not JSON");
      } else {
        res.end(
          JSON.stringify({
            logged_in: cookie.includes("=valid")
              ? true
              : cookie.includes("=string")
              ? "true"
              : false,
            user: { id: 7, email: "must-not-be-returned@example.com" },
          }),
        );
      }
    },
  );
  authServer.listen(0, "127.0.0.1");
  await once(authServer, "listening");
  const authPort = authServer.address().port;
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const appPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const env = { ...process.env };
  // Prevent any local provider credentials from entering the test server.
  for (const line of (
    await readFile(path.join(root, ".env.local"), "utf8").catch(() => "")
  ).split("\n")) {
    const name = line.match(/^\s*([A-Z_0-9]+)\s*=/)?.[1];
    if (name && /KEY|SECRET|TOKEN/.test(name)) env[name] = "";
  }
  Object.assign(env, {
    AUTH_CHECK_URL: `https://127.0.0.1:${authPort}/auth-check.php`,
    AUTH_REDIRECT_URL: "https://login.example.com/",
    NODE_EXTRA_CA_CERTS: cert,
    NEXT_TELEMETRY_DISABLED: "1",
    OPENAI_API_KEY: "test-system-key",
    CODE: "",
    ENABLE_MCP: "",
    PROXY_ALLOWED_ORIGINS: "",
  });
  app = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.on("data", (chunk) => {
    output += chunk;
  });
  app.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const origin = `http://127.0.0.1:${appPort}`;
  const call = (url, options = {}) =>
    fetch(`${origin}${url}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      ...options,
    });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(`Next exited: ${output}`);
    try {
      ready = (await call("/api/auth-gate")).status === 401;
      if (ready) break;
    } catch {
      /* wait for the server */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, `Next did not become ready: ${output}`);
  const check = async (label, url, status, options = {}) => {
    const response = await call(url, options);
    assert.equal(response.status, status, label);
    checks++;
    console.log(`PASS ${label}: ${status}`);
    return response;
  };
  const logged = { Cookie: "wordpress_logged_in_test=valid" };
  const page = await check("anonymous page", "/", 307);
  assert.equal(page.headers.get("location"), "https://login.example.com/");
  assert.match(page.headers.get("cache-control"), /no-store/);
  for (const url of [
    "/api/auth-gate",
    "/api/auth-check",
    "/api/config",
    "/api/artifacts",
    "/api/tencent",
    "/api/upstash/get/test",
    "/api/webdav/test",
    "/api/openai/v1/models",
    "/api/custom/v1/models",
    "/api/proxy/openai/v1/models",
  ])
    await check(`anonymous ${url}`, url, 401);
  await check("anonymous model POST", "/api/openai/v1/chat/completions", 401, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await check("forged identity", "/api/config", 401, {
    headers: { "X-Auth-User": "1", Authorization: "Bearer forged" },
  });
  await check("legacy middleware bypass header on page", "/", 307, {
    headers: {
      "X-Middleware-Subrequest": Array(5).fill("middleware").join(":"),
    },
  });
  await check("legacy middleware bypass header on API", "/api/config", 401, {
    headers: {
      "X-Middleware-Subrequest": Array(5).fill("middleware").join(":"),
    },
  });
  const gate = await check(
    "valid WordPress session gate",
    "/api/auth-gate",
    200,
    { headers: logged },
  );
  assert.deepEqual(await gate.json(), { logged_in: true });
  assert.equal(gate.headers.get("x-auth-user"), "7");
  await check("valid session page", "/", 200, { headers: logged });
  const config = await check("valid session config API", "/api/config", 200, {
    headers: logged,
  });
  assert.match(config.headers.get("cache-control"), /no-store/);
  assert.equal((await config.json()).needCode, false);
  for (const [value, status] of [
    ["expired", 401],
    ["string", 401],
    ["down", 503],
    ["malformed", 503],
  ]) {
    await check(`session ${value}`, "/api/config", status, {
      headers: { Cookie: `wordpress_logged_in_test=${value}` },
    });
  }
  await check(
    "authenticated malicious proxy destination",
    "/api/custom/v1/models",
    403,
    {
      headers: {
        ...logged,
        "X-Base-URL": "https://api.openai.com.attacker.example",
      },
    },
  );
  console.log(
    `${checks} production HTTP checks passed; no real provider was called.`,
  );
} finally {
  if (app && app.exitCode === null) {
    const closed = once(app, "close");
    app.kill("SIGTERM");
    await closed;
  }
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
