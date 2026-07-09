import { buildPublicApp } from './app';
import { config } from './config';
import { connect } from './db';

// Web-only entrypoint. Runs ONLY the public portal/admin app (launcher, auth,
// admin UI, access API) — it does NOT start the internal verify listener, which
// is owned by the separate menagerai-verify container (server-gateway.ts).
// Deploy with GATEWAY_PUBLIC=false so /gateway/verify is not mounted here either;
// all verification is handled by the isolated verifier.
async function main(): Promise<void> {
  await connect();
  buildPublicApp({ mountGateway: config.gatewayPublic }).listen(config.port, () => {
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
