import { buildPublicApp } from './app';
import { config } from './config';
import { connect } from './db';
import { ensureDemoApp, ensureSuperadmin } from './bootstrap';
import { logStartupProblems, runStartupChecks } from './startup';

// Web-only entrypoint. Runs ONLY the public portal/admin app (launcher, auth,
// admin UI, access API) — it does NOT start the internal verify listener, which
// is owned by the separate menagerai-verify container (server-gateway.ts).
// Deploy with GATEWAY_PUBLIC=false so /gateway/verify is not mounted here either;
// all verification is handled by the isolated verifier.
async function main(): Promise<void> {
  await connect();

  // Same preflight-then-gated-seed contract as server-all: validate env + live
  // Logto connections first; only seed when valid, else serve the config screen.
  const startup = await runStartupChecks();
  if (startup.ok) {
    await ensureSuperadmin(config.superadminEmail);
    await ensureDemoApp(config.superadminEmail);
  } else {
    logStartupProblems(startup);
  }

  buildPublicApp({ mountGateway: config.gatewayPublic, startup }).listen(config.port, () => {
    console.log(`menagerai web listening on :${config.port} (base ${config.baseUrl})`);
    if (config.gatewayPublic) {
      console.log('  WARNING: GATEWAY_PUBLIC=true — verify is also mounted on the web app; set it false for the isolated end-state');
    }
  });
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
