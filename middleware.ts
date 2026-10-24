import { NextRequest, NextResponse } from "next/server";
import {
  authFailure,
  checkExternalAuth,
  externalAuthEnabled,
  privateAuthHeaders,
} from "./app/utils/external-auth";

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const gate = /^\/api\/auth-(gate|check)\/?$/.test(path);
  if (!externalAuthEnabled()) {
    // A Caddy forward_auth probe must never succeed with auth misconfigured.
    return gate ? authFailure("unavailable") : NextResponse.next();
  }

  const api = path === "/api" || path.startsWith("/api/");
  // Normal API routes authenticate themselves. Rewrites in next.config.mjs
  // bypass route handlers, so these proxy requests must be checked here too.
  if (api && !gate && !path.startsWith("/api/proxy/")) {
    return NextResponse.next();
  }
  // Only immutable framework assets are public; never exempt based on suffix.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    path.startsWith("/_next/static/")
  ) {
    return NextResponse.next();
  }

  const result = await checkExternalAuth(req);
  if (result.status === "authenticated") {
    if (gate) {
      const response = NextResponse.json(
        { logged_in: true },
        { headers: privateAuthHeaders },
      );
      if (result.userId) response.headers.set("X-Auth-User", result.userId);
      return response;
    }
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie");
    return response;
  }
  if (result.status !== "unauthenticated") return authFailure("unavailable");
  if (api || (req.method !== "GET" && req.method !== "HEAD")) {
    return authFailure("unauthenticated");
  }

  try {
    const login = new URL(process.env.AUTH_REDIRECT_URL?.trim() ?? "");
    if (login.protocol !== "https:" || login.username || login.password) {
      return authFailure("unavailable");
    }
    return NextResponse.redirect(login, {
      status: 307,
      headers: privateAuthHeaders,
    });
  } catch {
    return authFailure("unavailable");
  }
}

export const config = { matcher: ["/:path*"] };
