import { NextRequest, NextResponse } from "next/server";
import { checkExternalLogin, getAuthConfig } from "../../lib/auth-check";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = getAuthConfig();

  // Auth is disabled unless both URLs are configured.
  if (!auth.checkUrl || !auth.redirectUrl) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  const result = await checkExternalLogin(
    auth.checkUrl,
    request.headers.get("cookie"),
  );

  if (result.loggedIn) {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Cache-Control", "no-store");
    if (result.user?.username) {
      response.headers.set("X-Auth-User", result.user.username);
    }
    return response;
  }

  const response = NextResponse.redirect(auth.redirectUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
