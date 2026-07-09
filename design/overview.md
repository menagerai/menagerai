# Menagerai — Design Overview

## Background

An organization often has multiple internal applications deployed across departments. Some are protected by simple password challenges; others have app-local user or role systems. The goal is to create a central authentication and access-control layer so users sign in once and then receive access to approved apps. Menagerai grants access at the app level (a binary allow/deny per user and app); in-app roles, where an app needs them, remain that app's own concern.

## Goals

1. Provide a first-level organizational authentication layer based on approved users.
2. Support centralized user management and role-based access control.
3. Assign users and organizational roles to specific apps (a binary access gate per user and app).
4. Let individual apps consume central identity/access information without rebuilding auth from scratch in each repo.
5. Preserve each app's internal role logic where needed while centralizing top-level access.
6. Support auditability, offboarding, and future app onboarding.

## Non-goals

- Build a custom password/authentication system.
- Centralize fine-grained, in-app permissions in Menagerai (or in Logto). The Menagerai gate is binary; in-app roles/permissions stay in the app.
- Rewrite every existing app immediately.
- Treat possession of a work email address as automatic access to all apps.

## Recommended architecture

```text
User
  ↓
Logto hosted sign-in
  ↓
Menagerai / Admin Portal
  ↓
Individual apps
```

### Logto: identity provider

Logto should handle:

- Login / logout
- Email verification
- Hosted sign-in UI
- OIDC/OAuth2 tokens
- Session management
- MFA if needed later
- User identity fields such as `sub`, `email`, and `email_verified`

Logto answers:

> Who is this person?

### Menagerai: authorization source of truth

Menagerai should handle:

- Approved user lifecycle
- Email/domain approval rules
- User status: pending, active, disabled
- Organizational/platform roles
- App catalog
- Role-derived app grants (organizational role → app)
- Direct user allow/deny overrides
- Audit logs
- Logto user provisioning via Management API
- Access-check API for apps

Menagerai answers:

> What is this person allowed to access?

### Individual apps: enforcement

Each app should enforce access using one of three patterns:

1. Native OIDC integration.
2. Reverse-proxy / ForwardAuth integration.
3. Shared Menagerai auth SDK/middleware.

Apps answer:

> Given this authenticated user (whom Menagerai has already cleared to reach this app), should this specific request/function/page be allowed?

## Mental model

Keep identity and authorization separate.

```text
Identity
- handled by Logto
- example: alice@example.com, email_verified=true, sub=user_123

Authorization (gate-level)
- handled by Menagerai
- example: Alice may access Purchase Approval (binary allow); what she can do
  inside it is Purchase Approval's own concern
```

A valid work email should not imply app access. Recommended default behavior:

```text
Valid approved user can sign in
No assigned apps → sees “No apps assigned yet”
```

## Central app launcher

Build a lightweight portal, for example:

```text
https://portal.example.com
```

After login, users see only apps they can access:

```text
Welcome, Alice

Your apps:
- Finance Reconciliation
- Purchase Approval
- Sales Dashboard
```

Admin users additionally see:

```text
Admin
- User Management
- Role Management
- App Registry
- Audit Logs
- Access Review
```

## Final recommended policy

```text
Public registration: OFF

User creation:
  only through Menagerai

Login:
  Logto hosted sign-in

Authorization:
  Menagerai RBAC

App access:
  apps call Menagerai or receive trusted proxy claims

Offboarding:
  disable users in both Menagerai and Logto
```
