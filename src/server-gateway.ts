import { buildGatewayApp } from './app';
import { config } from './config';
import { connect } from './db';

// Verifier-only entrypoint. Runs ONLY the ForwardAuth gateway app (the Traefik
// `menagerai-auth` target), with no admin/portal UI in the same process — so heavy
// admin work (e.g. the CSV user import) can never block /gateway/verify for the
// whole fleet. Deploy this as its own container (menagerai-verify) alongside
// the web container (server-web.ts) built from the same image.
async function main(): Promise<void> {
  await connect();
  buildGatewayApp().listen(config.gatewayPort, () => {
    console.log(`menagerai verifier listening on :${config.gatewayPort} (verify-only)`);
  });
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
