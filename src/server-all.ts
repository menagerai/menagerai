import { buildGatewayApp, buildPublicApp } from './app';
import { config } from './config';
import { connect } from './db';

async function main(): Promise<void> {
  await connect();

  buildPublicApp({ mountGateway: config.gatewayPublic }).listen(config.port, () => {
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
