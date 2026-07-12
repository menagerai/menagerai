import { buildGatewayApp, buildPublicApp } from './app';
import { config } from './config';
import { connect } from './db';
import { ensureDemoApp, ensureSuperadmin } from './bootstrap';
import { logStartupProblems, runStartupChecks } from './startup';
import { runDemoStartupChecks } from './demo/startup';
import { logDemoSecrets } from './demo/seed';
import { performReset } from './demo/reset';

async function main(): Promise<void> {
  await connect();

  // Validate env BEFORE any bootstrap writes. Seeding runs only when valid; a
  // misconfigured instance boots but serves the configuration screen and writes
  // nothing. Demo mode uses a synchronous, IdP-free preflight instead of Logto's.
  const startup = config.demoMode ? runDemoStartupChecks() : await runStartupChecks();
  if (startup.ok) {
    if (config.demoMode) {
      // Always come up in the canonical seed: wipe + reseed on every boot (a
      // restart loses the in-memory reset timer anyway). Do NOT run ensureDemoApp
      // here — its empty-registry guard would fight the demo seed.
      await performReset();
      logDemoSecrets();
    } else {
      await ensureSuperadmin(config.superadminEmail);
      await ensureDemoApp(config.superadminEmail);
    }
  } else {
    logStartupProblems(startup);
  }

  buildPublicApp({ mountGateway: config.gatewayPublic, startup }).listen(config.port, () => {
    console.log(`menagerai listening on :${config.port} (base ${config.baseUrl})`);
    if (config.gatewayPublic) console.log('  /gateway/verify also served on the public app (GATEWAY_PUBLIC=true)');
  });

  // /gateway/verify on a dedicated internal-only port — see config.gatewayPort.
  buildGatewayApp().listen(config.gatewayPort, () => {
    console.log(`gateway verify (internal) listening on :${config.gatewayPort}`);
  });
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
