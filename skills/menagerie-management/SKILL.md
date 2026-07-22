---
name: menagerie-management
description: "Use when an agent or operator needs to manage a Menagerai deployment programmatically: users, roles, app registrations, app grants, per-user overrides, email allow rules, proxy secrets, or audit logs through the admin API."
version: 1.0.0
author: Menagerai contributors
license: LGPL-3.0-only
platforms: [linux, macos, windows]
prerequisites:
  env_vars: [MENAGERAI_ADMIN_API_KEY, MENAGERAI_BASE_URL]
  commands: [python3]
metadata:
  hermes:
    tags: [menagerai, administration, access-control, api, agents]
    related_skills: []
---

# Menagerie Management

## Overview

Menagerai exposes the same administrative capabilities used by its web UI through a JSON API. This skill helps an agent or operator safely manage users, roles, applications, role grants, per-user access overrides, email allow rules, proxy secrets, and audit records.

The API is mounted at `/api/admin`. Its OpenAPI 3.1 specification and interactive Swagger UI are generated from the same route registry as the live API, so the documentation stays aligned with the implementation.

Configure the deployment and a personal admin API key:

```bash
export MENAGERAI_BASE_URL="https://portal.example.com"
export MENAGERAI_ADMIN_API_KEY="dvk_..."
export MENAGERAI_ADMIN_API_PREFIX="/api/admin" # optional; this is the default
```

Create and revoke keys in **Admin → API access**. A key belongs to one administrator and carries that administrator's full admin power. The secret is displayed only once.

## When to Use

Use this skill to:

- list, search, create, update, enable, disable, or delete users;
- replace a user's roles or manage a per-app allow/deny override;
- create, edit, rename, or delete roles and manage their app grants;
- register, update, rename, or delete applications;
- rotate an application's ForwardAuth proxy secret;
- create, edit, toggle, or delete email allow rules;
- inspect the recent audit log;
- automate administration from an agent, CI job, or internal integration.

Do not use this API as an end-user login token or as an application proxy secret. It is an administrative credential.

## Discover the API

After signing in as an administrator, open:

- Interactive API reference: `${MENAGERAI_BASE_URL}/admin/docs`
- OpenAPI 3.1 document: `${MENAGERAI_BASE_URL}/admin/openapi.json`

Both documentation routes require an authenticated admin browser session. Live API requests use an API key.

Authenticate with the HTTP Bearer scheme or the `X-API-Key` header. For example:

```bash
curl -sS "$MENAGERAI_BASE_URL/api/admin/roles" \
  -H "$(printf 'X-API-Key: %s' "$MENAGERAI_ADMIN_API_KEY")" \
  -H "Accept: application/json"
```

Prefer Bearer authentication unless an intermediary strips the `Authorization` header.

## Safety Rules

1. **Treat an API key like a password.** Never print it, commit it, paste it into chat, or place it directly in a command. Read it from the environment.
2. **Read before writing.** Resolve user IDs, role keys, app keys, rule IDs, and current settings with a GET before changing them.
3. **Preserve intended state.** Role replacement is not additive: `POST /users/{id}/roles` replaces the full role list. Fetch the user and send the complete desired list.
4. **Confirm destructive or cascading actions.** User deletion, role/app deletion, key renames, and proxy-secret rotation can have immediate downstream effects.
5. **Prefer disable over delete.** Disabling a user revokes access while preserving the account and audit history.
6. **Coordinate proxy-secret rotation.** Update the matching application's runtime configuration before or immediately after rotation, or gateway trust may break.
7. **Read after writing.** Fetch the affected object and inspect `/audit` after important changes.
8. **Minimize output.** User records and exact email rules can contain private information. Return only fields needed for the task.
9. **Do not retry writes blindly.** On timeout or HTTP error, read the target and audit log first to determine whether the write already succeeded.

## Included Helper

This skill includes a standard-library-only Python helper:

```bash
SCRIPT="skills/menagerie-management/scripts/menagerai_management.py"
python3 "$SCRIPT" --help
```

Raw calls:

```bash
python3 "$SCRIPT" get /users
python3 "$SCRIPT" get '/users?q=jane@example.com'
python3 "$SCRIPT" post /users '{"email":"jane@example.com","roles":["staff"]}'
python3 "$SCRIPT" raw POST /users/USER_ID/disable
```

Convenience commands:

```bash
python3 "$SCRIPT" list-users --query jane
python3 "$SCRIPT" get-user USER_ID
python3 "$SCRIPT" create-user jane@example.com --name Jane --department Sales --role staff
python3 "$SCRIPT" set-user-roles USER_ID staff sales
python3 "$SCRIPT" set-override USER_ID app_key allow --reason "approved temporary access"
python3 "$SCRIPT" delete-override USER_ID app_key
python3 "$SCRIPT" disable-user USER_ID
python3 "$SCRIPT" enable-user USER_ID

python3 "$SCRIPT" list-roles
python3 "$SCRIPT" create-role sales --name Sales --description "Sales team"
python3 "$SCRIPT" grant-role-app sales crm
python3 "$SCRIPT" revoke-role-app sales crm

python3 "$SCRIPT" list-apps
python3 "$SCRIPT" create-app crm --name CRM --description "Customer management"
python3 "$SCRIPT" update-app crm --status active --default-base-url https://apps.example.com
python3 "$SCRIPT" rotate-app-secret crm

python3 "$SCRIPT" list-email-rules
python3 "$SCRIPT" create-email-rule domain example.com --description "Company accounts"
python3 "$SCRIPT" toggle-email-rule RULE_ID
python3 "$SCRIPT" audit
```

The helper prints formatted JSON and exits non-zero for HTTP/network errors. API app responses may contain a `proxy_secret`; filter or redact that field before including output in logs or messages.

## Endpoint Reference

All paths are relative to `/api/admin`.

### Users

| Method | Path | Purpose |
|---|---|---|
| GET | `/users?q=<text>` | List/search users, up to 200 |
| GET | `/users/{id}` | Get one user |
| POST | `/users` | Create a user |
| POST | `/users/import` | Bulk-provision users from a roster |
| POST | `/users/{id}/profile` | Update name/department |
| POST | `/users/{id}/roles` | Replace all roles |
| POST | `/users/{id}/overrides` | Set a per-app allow/deny override |
| POST | `/users/{id}/overrides/delete` | Remove a per-app override |
| POST | `/users/{id}/disable` | Disable user and revoke sessions |
| POST | `/users/{id}/enable` | Re-enable user |
| POST | `/users/{id}/delete` | Permanently delete user |

### Roles

| Method | Path | Purpose |
|---|---|---|
| GET | `/roles` | List roles |
| GET | `/roles/{key}` | Get one role |
| POST | `/roles` | Create a role |
| POST | `/roles/{key}/edit` | Edit name/description |
| POST | `/roles/{key}/rename` | Rename key and cascade references |
| POST | `/roles/{key}/grants` | Grant an app |
| POST | `/roles/{key}/grants/delete` | Revoke an app grant |
| POST | `/roles/{key}/delete` | Delete and unassign the role |

### Apps

| Method | Path | Purpose |
|---|---|---|
| GET | `/apps` | List apps |
| GET | `/apps/{key}` | Get one app |
| POST | `/apps` | Register an app |
| POST | `/apps/{key}` | Update app configuration |
| POST | `/apps/{key}/rename` | Rename key and cascade references |
| POST | `/apps/{key}/delete` | Delete an app |
| POST | `/apps/{key}/regenerate-secret` | Rotate its proxy secret |

`public_paths` is an array of `{ "method", "pattern" }` objects. Keep anonymous paths narrow. `default_base_url`, when used, should be the trusted public origin for the application.

### Email rules and audit

| Method | Path | Purpose |
|---|---|---|
| GET | `/email-rules` | List allow rules |
| POST | `/email-rules` | Create an `exact` or `domain` rule |
| POST | `/email-rules/{id}/description` | Update description |
| POST | `/email-rules/{id}/toggle` | Enable/disable a rule |
| POST | `/email-rules/{id}/delete` | Delete a rule |
| GET | `/audit` | Return the latest 200 audit entries |

API-triggered activity is stamped as API activity and attributed to the key, making agent and integration actions distinguishable from UI actions.

## Common Workflows

### Add a user with role access

1. Search by exact email to avoid duplicates.
2. List roles and validate every requested role key.
3. Create the user, or fetch the existing user and compute the complete final role list.
4. Read the user back.
5. Check the audit log.

### Grant one application to a role

1. GET the role and app to confirm both identifiers.
2. POST the app key to `/roles/{role}/grants`.
3. GET the role again and verify the grant.
4. Check the audit log.

### Register an application

1. Search/list apps to avoid duplicate keys.
2. Register the key, human name, and useful description.
3. Configure its base URL/public paths if needed.
4. Add role grants or explicit user overrides.
5. Configure the generated proxy secret in the protected app without logging it.
6. Verify app access and audit records end to end.

## Error Handling

- `400` — invalid request or schema validation failure. Read the returned issues and correct the payload.
- `401` — missing, unknown, or revoked API key.
- `403` — key owner is not an active administrator, or the operation is forbidden.
- `404` — resource or route not found. Confirm the identifier and `/api/admin` prefix.
- `500` — server failure. Do not repeat a write until target state and audit have been checked.

## Verification Checklist

- [ ] `MENAGERAI_BASE_URL` points to the intended deployment.
- [ ] `MENAGERAI_ADMIN_API_KEY` is loaded without being printed.
- [ ] Resource identifiers and current state were fetched before mutation.
- [ ] Destructive/cascading operations were explicitly authorized.
- [ ] Role replacement preserves every role that should remain.
- [ ] Proxy-secret changes are coordinated with application runtime configuration.
- [ ] The affected object was read back after the write.
- [ ] Important writes appear once in the audit log.
- [ ] No API key, proxy secret, or unnecessary personal data appears in output.
