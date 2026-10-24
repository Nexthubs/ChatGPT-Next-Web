import { NextRequest, NextResponse } from "next/server";

type AuthResult =
  | { status: "disabled" | "unauthenticated" | "unavailable" }
  | { status: "authenticated"; userId?: string };

export function externalAuthEnabled() {
  return !!process.env.AUTH_CHECK_URL?.trim();
}

// Never trust a browser-supplied identity header or a client-side login flag.
export async function checkExternalAuth(req: Request): Promise<AuthResult> {
  if (!externalAuthEnabled()) return { status: "disabled" };

  let endpoint: URL;
  try {
    endpoint = new URL(process.env.AUTH_CHECK_URL!.trim());
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password
    ) {
      return { status: "unavailable" };
    }
  } catch {
    return { status: "unavailable" };
  }

  const cookie = req.headers.get("cookie");
  if (!cookie) return { status: "unauthenticated" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthenticated" };
    }
    if (!response.ok) return { status: "unavailable" };
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("logged_in" in data) ||
      data.logged_in !== true
    ) {
      return { status: "unauthenticated" };
    }

    const user = "user" in data ? data.user : undefined;
    const id =
      user && typeof user === "object" && "id" in user ? user.id : undefined;
    return {
      status: "authenticated",
      userId:
        typeof id === "number" && Number.isSafeInteger(id) && id > 0
          ? String(id)
          : undefined,
    };
  } catch {
    // Includes network failures, timeouts, invalid JSON and redirect responses.
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export const privateAuthHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

export function authFailure(status: "unauthenticated" | "unavailable") {
  return NextResponse.json(
    {
      error: true,
      logged_in: false,
      code: status === "unavailable" ? "AUTH_UNAVAILABLE" : "LOGIN_REQUIRED",
    },
    {
      status: status === "unavailable" ? 503 : 401,
      headers: privateAuthHeaders,
    },
  );
}

// Route-level checks also protect APIs independently of middleware and Caddy.
export function withExternalAuth<Args extends unknown[]>(
  handler: (req: NextRequest, ...args: Args) => Promise<Response>,
) {
  return async (req: NextRequest, ...args: Args) => {
    const result = await checkExternalAuth(req);
    if (
      result.status === "unauthenticated" ||
      result.status === "unavailable"
    ) {
      return authFailure(result.status);
    }
    const response = await handler(req, ...args);
    if (result.status === "disabled") return response;
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    const vary = headers.get("Vary");
    headers.set("Vary", vary ? `${vary}, Cookie` : "Cookie");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
