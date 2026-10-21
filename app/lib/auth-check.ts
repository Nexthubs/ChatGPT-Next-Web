export type AuthUser = {
  id?: number;
  username?: string;
  display_name?: string;
  email?: string;
  roles?: string[];
};

export type AuthResult = {
  loggedIn: boolean;
  user: AuthUser | null;
  loginUrl: string | null;
};

const AUTH_CHECK_TIMEOUT = 5000;

/**
 * Returns the runtime auth configuration.
 * Auth is only enabled when both URLs are configured.
 */
export function getAuthConfig() {
  // Read these directly instead of getServerSideConfig(), which initializes
  // every provider config and logs API key usage on each request.
  const checkUrl = process.env.AUTH_CHECK_URL?.trim() || null;
  const redirectUrl = process.env.AUTH_REDIRECT_URL?.trim() || null;

  return {
    enabled: Boolean(checkUrl && redirectUrl),
    checkUrl,
    redirectUrl,
  };
}

/**
 * Check the WordPress login state by forwarding the incoming Cookie header.
 * Cookies are shared on the `.nexthubs.cn` domain, so the browser sends the
 * WordPress cookies to this app as well.
 */
export async function checkExternalLogin(
  checkUrl: string,
  cookie: string | null,
): Promise<AuthResult> {
  try {
    const response = await fetch(checkUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT),
    });

    if (!response.ok) {
      return { loggedIn: false, user: null, loginUrl: null };
    }

    const data = await response.json();

    return {
      loggedIn: data?.logged_in === true,
      user: data?.user ?? null,
      loginUrl: data?.login_url ?? null,
    };
  } catch (error) {
    console.error("[Auth] failed to check external login", error);
    return { loggedIn: false, user: null, loginUrl: null };
  }
}
