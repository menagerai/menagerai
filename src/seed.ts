import { config } from './config';
import { close, connect, col } from './db';
import { ensureDemoApp, ensureSuperadmin } from './bootstrap';

// Idempotent bootstrap CLI (`npm run seed`): superadmin + an example domain rule +
// a demo app. The same helpers back the first-run setup wizard. Safe to re-run.
async function seed(): Promise<void> {
  await connect();
  const email = config.superadminEmail;

  await ensureSuperadmin(email);

  // An example corporate domain rule (seed-only convenience — replace or delete it
  // from Admin → Email rules). The wizard does not add this.
  await col.emailRules.updateOne(
    { type: 'domain', pattern: 'example.com' },
    { $setOnInsert: { type: 'domain', pattern: 'example.com', description: 'Example allowed domain (replace me)', status: 'active', created_at: new Date() } },
    { upsert: true },
  );

  const secret = await ensureDemoApp(email);

  console.log('--- seed complete ---');
  console.log(`superadmin: ${email} (system_admin, access to demo)`);
  console.log(`demo MENAGERAI_PROXY_SECRET: ${secret}`);
  console.log('Set that secret as the demo app env var MENAGERAI_PROXY_SECRET.');
  await close();
}

seed().catch((err) => {
  console.error('seed failed', err);
  process.exit(1);
});
