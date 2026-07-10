import { close, connect } from './db';
import { relinkUser } from './bootstrap';

// Break-glass recovery (`npm run relink -- <email>`): clear a user's IdP link and
// re-ensure system_admin standing, so a locked-out or migrated superadmin can
// re-claim the account on the next sign-in. The credential-free equivalent of a
// password reset, run by whoever has shell/DB access.
async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run relink -- <email>');
    process.exit(1);
  }
  await connect();
  await relinkUser(email);
  console.log(
    `Relinked ${email.toLowerCase()}: IdP link cleared and system_admin ensured. ` +
      'Sign in with this email at your IdP to re-claim the account.',
  );
  await close();
}

main().catch((err) => {
  console.error('relink failed', err);
  process.exit(1);
});
