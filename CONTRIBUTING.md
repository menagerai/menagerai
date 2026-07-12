# Contributing to Menagerai

Thanks for your interest in contributing. Menagerai is an open-source access-control plane; because it governs access to other people's apps, we hold a high bar on correctness, security, and scope. This guide explains how to work with us.

## Ways to contribute

- **Report a bug** — open an issue with steps to reproduce, expected vs. actual behavior, and your environment. For **security** issues, follow [SECURITY.md](./SECURITY.md) instead — do not open a public issue.
- **Propose a feature** — open a discussion first. Please read *What this is not* in the [README](./README.md); we intentionally keep the core small and push extensibility to the pluggable seams (identity provider, reverse proxy, data store) rather than growing surface area.
- **Improve docs** — the design docs and onboarding guides are a first-class part of the project; doc PRs are very welcome.
- **Send code** — see below.

## Development workflow

1. Fork the repo and create a topic branch off `main`.
2. Make your change with tests. The project ships a test suite; new behavior needs coverage and existing tests must pass.
3. Run the linter, formatter, and tests locally before pushing (commands will be documented in the README once the codebase lands).
4. Open a pull request against `main` with a clear description of the *why*, not just the *what*. Link any related issue or discussion.

## Commit and PR conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). This drives changelogs and releases.
- Keep PRs focused — one logical change per PR is easier to review and revert.
- PRs must pass CI (tests, lint, and security checks) before review.

## Design principles to keep in mind

- **Default-deny.** Authorization changes must fail closed. When in doubt, deny.
- **Delegate authentication.** We never store credentials; keep it that way.
- **Pluggable seams.** Prefer extending the identity-provider / proxy / data-store interfaces over hardcoding a new vendor.
- **Single-tenant honesty.** One deployment = one organization; don't smuggle in multi-tenancy assumptions.

## Licensing of contributions

Menagerai is licensed under **AGPL-3.0** (see [LICENSE](./LICENSE)). By submitting a contribution, you agree that it is licensed under the same terms and that you have the right to contribute it.

## Code of Conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). Be kind.
