#!/usr/bin/env python3
"""Menagerai management API helper.

Reads:
  MENAGERAI_ADMIN_API_KEY     required
  MENAGERAI_BASE_URL    optional, default http://localhost:3000
  MENAGERAI_ADMIN_API_PREFIX      optional, default /api/admin

Usage examples:
  python3 menagerai_management.py get /users
  python3 menagerai_management.py list-users --query jane
  python3 menagerai_management.py post /users '{"email":"jane@example.com"}'
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_PREFIX = "/api/admin"


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def get_config() -> tuple[str, str, str]:
    key = os.environ.get("MENAGERAI_ADMIN_API_KEY")
    if not key:
        eprint("Missing required env var: MENAGERAI_ADMIN_API_KEY")
        sys.exit(2)
    base = os.environ.get("MENAGERAI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    prefix = os.environ.get("MENAGERAI_ADMIN_API_PREFIX", DEFAULT_PREFIX)
    if not prefix.startswith("/"):
        prefix = "/" + prefix
    prefix = prefix.rstrip("/")
    return key, base, prefix


def parse_json_body(text: str | None) -> Any | None:
    if text is None or text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        eprint(f"Invalid JSON body: {exc}")
        sys.exit(2)


def make_url(base: str, prefix: str, path: str, query: dict[str, str | None] | None = None) -> str:
    if not path.startswith("/"):
        path = "/" + path
    # If caller passes a full admin path, do not double-prefix.
    if path.startswith(prefix + "/") or path == prefix:
        full_path = path
    elif path.startswith("/api/admin/") or path == "/api/admin":
        full_path = path
    else:
        full_path = prefix + path
    url = base + full_path
    if query:
        clean = {k: v for k, v in query.items() if v is not None and v != ""}
        if clean:
            sep = "&" if "?" in url else "?"
            url += sep + urllib.parse.urlencode(clean)
    return url


def request(method: str, path: str, body: Any | None = None, query: dict[str, str | None] | None = None) -> Any:
    key, base, prefix = get_config()
    url = make_url(base, prefix, path, query)
    data = None
    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            if not raw:
                return {"ok": True, "status": resp.status}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"status": resp.status, "text": raw}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"text": raw}
        eprint(json.dumps({
            "error": "HTTPError",
            "status": exc.code,
            "reason": exc.reason,
            "url": url,
            "response": payload,
        }, ensure_ascii=False, indent=2))
        sys.exit(1)
    except urllib.error.URLError as exc:
        eprint(json.dumps({"error": "URLError", "reason": str(exc.reason), "url": url}, ensure_ascii=False, indent=2))
        sys.exit(1)


def emit(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True))


def cmd_raw(args: argparse.Namespace) -> None:
    emit(request(args.method, args.path, parse_json_body(args.body)))


def cmd_get(args: argparse.Namespace) -> None:
    emit(request("GET", args.path))


def cmd_post(args: argparse.Namespace) -> None:
    emit(request("POST", args.path, parse_json_body(args.body) if args.body else None))


def cmd_list_users(args: argparse.Namespace) -> None:
    emit(request("GET", "/users", query={"q": args.query}))


def cmd_get_user(args: argparse.Namespace) -> None:
    emit(request("GET", f"/users/{urllib.parse.quote(args.id, safe='')}"))


def cmd_create_user(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"email": args.email}
    if args.name: body["name"] = args.name
    if args.department: body["department"] = args.department
    if args.role: body["roles"] = args.role
    emit(request("POST", "/users", body))


def cmd_set_user_roles(args: argparse.Namespace) -> None:
    emit(request("POST", f"/users/{urllib.parse.quote(args.id, safe='')}/roles", {"roles": args.roles}))


def cmd_set_override(args: argparse.Namespace) -> None:
    body = {"app": args.app, "effect": args.effect}
    if args.reason: body["reason"] = args.reason
    emit(request("POST", f"/users/{urllib.parse.quote(args.id, safe='')}/overrides", body))


def cmd_delete_override(args: argparse.Namespace) -> None:
    emit(request("POST", f"/users/{urllib.parse.quote(args.id, safe='')}/overrides/delete", {"app": args.app}))


def cmd_user_toggle(args: argparse.Namespace, action: str) -> None:
    emit(request("POST", f"/users/{urllib.parse.quote(args.id, safe='')}/{action}"))


def cmd_list_roles(_: argparse.Namespace) -> None:
    emit(request("GET", "/roles"))


def cmd_create_role(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"key": args.key}
    if args.name: body["name"] = args.name
    if args.description: body["description"] = args.description
    emit(request("POST", "/roles", body))


def cmd_role_app(args: argparse.Namespace, delete: bool = False) -> None:
    suffix = "/grants/delete" if delete else "/grants"
    emit(request("POST", f"/roles/{urllib.parse.quote(args.key, safe='')}{suffix}", {"app": args.app}))


def cmd_list_apps(_: argparse.Namespace) -> None:
    emit(request("GET", "/apps"))


def cmd_create_app(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"key": args.key}
    if args.name: body["name"] = args.name
    if args.description: body["description"] = args.description
    emit(request("POST", "/apps", body))


def cmd_update_app(args: argparse.Namespace) -> None:
    # IMPORTANT: the app update endpoint behaves like a form save, not a PATCH:
    # omitted fields such as description/public_paths may be cleared. Read the
    # current app first and submit a full safe body, then override requested fields.
    key = urllib.parse.quote(args.key, safe="")
    current = request("GET", f"/apps/{key}")
    body: dict[str, Any] = {
        "name": current.get("name") or args.key,
        "description": current.get("description") or "",
        "status": current.get("status") or "active",
        "public_paths": current.get("public_paths") or [],
    }
    if current.get("default_base_url") is not None:
        body["default_base_url"] = current.get("default_base_url")
    if args.name is not None: body["name"] = args.name
    if args.description is not None: body["description"] = args.description
    if args.status is not None: body["status"] = args.status
    if args.public_path is not None: body["public_paths"] = args.public_path
    if args.default_base_url is not None: body["default_base_url"] = args.default_base_url
    emit(request("POST", f"/apps/{key}", body))


def cmd_rotate_app_secret(args: argparse.Namespace) -> None:
    emit(request("POST", f"/apps/{urllib.parse.quote(args.key, safe='')}/regenerate-secret"))


def cmd_list_email_rules(_: argparse.Namespace) -> None:
    emit(request("GET", "/email-rules"))


def cmd_create_email_rule(args: argparse.Namespace) -> None:
    body: dict[str, Any] = {"type": args.type, "pattern": args.pattern}
    if args.description: body["description"] = args.description
    emit(request("POST", "/email-rules", body))


def cmd_toggle_email_rule(args: argparse.Namespace) -> None:
    emit(request("POST", f"/email-rules/{urllib.parse.quote(args.id, safe='')}/toggle"))


def cmd_audit(_: argparse.Namespace) -> None:
    emit(request("GET", "/audit"))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Menagerai management API helper")
    sub = p.add_subparsers(dest="command", required=True)

    raw = sub.add_parser("raw", help="Raw request: raw METHOD PATH [JSON_BODY]")
    raw.add_argument("method")
    raw.add_argument("path")
    raw.add_argument("body", nargs="?")
    raw.set_defaults(func=cmd_raw)

    get = sub.add_parser("get", help="GET PATH")
    get.add_argument("path")
    get.set_defaults(func=cmd_get)

    post = sub.add_parser("post", help="POST PATH [JSON_BODY]")
    post.add_argument("path")
    post.add_argument("body", nargs="?")
    post.set_defaults(func=cmd_post)

    lu = sub.add_parser("list-users")
    lu.add_argument("--query", "-q")
    lu.set_defaults(func=cmd_list_users)

    gu = sub.add_parser("get-user")
    gu.add_argument("id")
    gu.set_defaults(func=cmd_get_user)

    cu = sub.add_parser("create-user")
    cu.add_argument("email")
    cu.add_argument("--name")
    cu.add_argument("--department")
    cu.add_argument("--role", action="append")
    cu.set_defaults(func=cmd_create_user)

    sr = sub.add_parser("set-user-roles")
    sr.add_argument("id")
    sr.add_argument("roles", nargs="+")
    sr.set_defaults(func=cmd_set_user_roles)

    so = sub.add_parser("set-override")
    so.add_argument("id")
    so.add_argument("app")
    so.add_argument("effect", choices=["allow", "deny"])
    so.add_argument("--reason")
    so.set_defaults(func=cmd_set_override)

    do = sub.add_parser("delete-override")
    do.add_argument("id")
    do.add_argument("app")
    do.set_defaults(func=cmd_delete_override)

    du = sub.add_parser("disable-user")
    du.add_argument("id")
    du.set_defaults(func=lambda a: cmd_user_toggle(a, "disable"))

    eu = sub.add_parser("enable-user")
    eu.add_argument("id")
    eu.set_defaults(func=lambda a: cmd_user_toggle(a, "enable"))

    sub.add_parser("list-roles").set_defaults(func=cmd_list_roles)
    cr = sub.add_parser("create-role")
    cr.add_argument("key")
    cr.add_argument("--name")
    cr.add_argument("--description")
    cr.set_defaults(func=cmd_create_role)

    gra = sub.add_parser("grant-role-app")
    gra.add_argument("key")
    gra.add_argument("app")
    gra.set_defaults(func=lambda a: cmd_role_app(a, False))

    rra = sub.add_parser("revoke-role-app")
    rra.add_argument("key")
    rra.add_argument("app")
    rra.set_defaults(func=lambda a: cmd_role_app(a, True))

    sub.add_parser("list-apps").set_defaults(func=cmd_list_apps)
    ca = sub.add_parser("create-app")
    ca.add_argument("key")
    ca.add_argument("--name")
    ca.add_argument("--description")
    ca.set_defaults(func=cmd_create_app)

    ua = sub.add_parser("update-app")
    ua.add_argument("key")
    ua.add_argument("--name")
    ua.add_argument("--description")
    ua.add_argument("--status")
    ua.add_argument("--public-path", action="append")
    ua.add_argument("--default-base-url")
    ua.set_defaults(func=cmd_update_app)

    ras = sub.add_parser("rotate-app-secret")
    ras.add_argument("key")
    ras.set_defaults(func=cmd_rotate_app_secret)

    sub.add_parser("list-email-rules").set_defaults(func=cmd_list_email_rules)
    cer = sub.add_parser("create-email-rule")
    cer.add_argument("type")
    cer.add_argument("pattern")
    cer.add_argument("--description")
    cer.set_defaults(func=cmd_create_email_rule)

    ter = sub.add_parser("toggle-email-rule")
    ter.add_argument("id")
    ter.set_defaults(func=cmd_toggle_email_rule)

    sub.add_parser("audit").set_defaults(func=cmd_audit)
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
