import { buildGatewayApp, buildPublicApp } from './app';
import { config } from './config';
import { connect } from './db';
import { ensureDemoApp, ensureSuperadmin } from './bootstrap';
import { logStartupProblems, runStartupChecks } from './startup';

async function main(): Promise<void> {
  await connect();

  // Validate env + live Logto connections BEFORE any bootstrap writes. Seeding runs
  // only when everything is valid; a misconfigured instance boots but serves the
  // configuration screen (see buildPublicApp) and writes no bootstrap state.
  const startup = await runStartupChecks();
  if (startup.ok) {
    await ensureSuperadmin(config.superadminEmail);
    await ensureDemoApp(config.superadminEmail);
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
