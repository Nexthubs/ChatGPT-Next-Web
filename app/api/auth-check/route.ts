import { NextRequest, NextResponse } from "next/server";
import { checkExternalLogin, getAuthConfig } from "../../lib/auth-check";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = getAuthConfig();

  if (!auth.checkUrl || !auth.redirectUrl) {
    return NextResponse.json(
      {
        enabled: false,
        logged_in: true,
        user: null,
        redirect_url: null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const result = await checkExternalLogin(
    auth.checkUrl,
    request.headers.get("cookie"),
  );

  return NextResponse.json(
    {
      enabled: true,
      logged_in: result.loggedIn,
      user: result.user,
      redirect_url: auth.redirectUrl,
      login_url: result.loginUrl,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
