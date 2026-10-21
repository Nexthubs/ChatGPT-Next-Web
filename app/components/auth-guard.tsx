"use client";

import { useEffect, useRef, useState } from "react";
import { Loading } from "./home";
import { IconButton } from "./button";

const AUTH_CHECK_TIMEOUT = 10 * 1000;

type AuthStatus = "checking" | "authenticated" | "error";

type AuthCheckResult = {
  enabled: boolean;
  loggedIn: boolean;
  redirectUrl: string | null;
};

async function checkLoginStatus(signal: AbortSignal): Promise<AuthCheckResult> {
  const response = await fetch("/api/auth-check", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`auth check failed with status ${response.status}`);
  }

  const data = await response.json();

  return {
    enabled: data?.enabled !== false,
    loggedIn: data?.logged_in === true,
    redirectUrl:
      typeof data?.redirect_url === "string" && data.redirect_url
        ? data.redirect_url
        : null,
  };
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const redirecting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      AUTH_CHECK_TIMEOUT,
    );
    let cancelled = false;

    const verify = async () => {
      try {
        const result = await checkLoginStatus(controller.signal);

        if (cancelled) {
          return;
        }

        // Auth is disabled when the env variables are not configured.
        if (!result.enabled || result.loggedIn) {
          setStatus("authenticated");
          return;
        }

        if (!result.redirectUrl) {
          setStatus("error");
          return;
        }

        if (!redirecting.current) {
          redirecting.current = true;
          window.location.replace(result.redirectUrl);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("[Auth] failed to check login status", error);
          setStatus("error");
        }
      } finally {
        window.clearTimeout(timeout);
      }
    };

    verify();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  if (status === "authenticated") {
    return <>{children}</>;
  }

  if (status === "error") {
    return (
      <div
        style={{
          display: "flex",
          height: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <div>登录状态检查失败，请刷新页面重试。</div>
        <IconButton
          type="primary"
          text="刷新"
          onClick={() => window.location.reload()}
        />
      </div>
    );
  }

  return <Loading />;
}
