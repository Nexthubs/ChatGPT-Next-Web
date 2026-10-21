import { Analytics } from "@vercel/analytics/react";
import { AuthGuard } from "./components/auth-guard";
import { Home } from "./components/home";
import { getServerSideConfig } from "./config/server";

const serverConfig = getServerSideConfig();

export default async function App() {
  return (
    <>
      <AuthGuard>
        <Home />
      </AuthGuard>
      {serverConfig?.isVercel && (
        <>
          <Analytics />
        </>
      )}
    </>
  );
}
