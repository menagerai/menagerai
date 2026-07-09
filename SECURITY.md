# Security Policy

Menagerai is an access-control plane: a vulnerability in it can affect every app behind
the gateway. We take reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Private Vulnerability Reporting](https://github.com/menagerai/menagerai/security/advisories/new)**
(Security → Advisories → *Report a vulnerability*).

Please include:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge a report within **72 hours** and to provide a remediation timeline
after triage. We will keep you updated through resolution and credit you in the advisory
unless you prefer to remain anonymous.

## Scope

In scope: the portal, the authorization engine, the ForwardAuth gateway, session
handling, the admin API, and provisioning integrations.

Out of scope: vulnerabilities in third-party dependencies (report those upstream, though
we welcome a heads-up), and issues that require a pre-compromised host or a malicious
operator with administrative access.

## Supported versions

The project is pre-1.0. Until a stable release line exists, only the latest `main` is
supported. This section will list supported versions once releases begin.

## Our security posture

By design, Menagerai **delegates authentication to a certified OIDC identity provider and
never stores credentials**. This deliberately shrinks the security surface we own to
*authorization and the portal*. The threat model — path-normalization defenses, host
allowlisting, and the isolated internal verify port — is documented alongside the code.
