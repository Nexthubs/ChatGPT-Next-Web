import { NextRequest, NextResponse } from "next/server";
import { ModelProvider, OpenaiPath } from "@/app/constant";
import { auth } from "./auth";

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[Proxy Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }
  // remove path params from searchParams
  req.nextUrl.searchParams.delete("path");
  req.nextUrl.searchParams.delete("provider");

  const subpath = params.path.join("/");
  let fetchUrl: URL;
  try {
    const base = new URL(req.headers.get("x-base-url") ?? "");
    const allowedOrigins = new Set([
      "https://api.openai.com",
      ...(process.env.PROXY_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ]);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !allowedOrigins.has(base.origin)
    ) {
      throw new Error("Untrusted proxy destination");
    }
    fetchUrl = new URL(`${base.href.replace(/\/$/, "")}/${subpath}`);
    fetchUrl.search = req.nextUrl.searchParams.toString();
    if (fetchUrl.origin !== base.origin) throw new Error("Invalid proxy path");
  } catch {
    return NextResponse.json(
      { error: true, msg: "Proxy destination is not allowed" },
      { status: 403 },
    );
  }

  // Only the exact trusted OpenAI origin may receive the system OpenAI key.
  if (fetchUrl.origin === "https://api.openai.com") {
    if (
      !new Set<string>(Object.values(OpenaiPath)).has(
        fetchUrl.pathname.slice(1),
      )
    ) {
      return NextResponse.json(
        { error: true, msg: "Proxy path is not allowed" },
        { status: 403 },
      );
    }
    const authResult = auth(req, ModelProvider.GPT);
    if (authResult.error) return NextResponse.json(authResult, { status: 401 });
  }
  const skipHeaders = ["connection", "host", "origin", "referer", "cookie"];
  const headers = new Headers(
    Array.from(req.headers.entries()).filter((item) => {
      if (
        item[0].indexOf("x-") > -1 ||
        item[0].indexOf("sec-") > -1 ||
        skipHeaders.includes(item[0])
      ) {
        return false;
      }
      return true;
    }),
  );
  const controller = new AbortController();
  const fetchOptions: RequestInit = {
    headers,
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
