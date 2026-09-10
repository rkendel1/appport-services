from __future__ import annotations

import argparse
from datetime import datetime
import sys
from typing import Sequence

from appport_services.api_keys.service import ApiKeyService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="appport")
    subparsers = parser.add_subparsers(dest="command", required=True)

    api_key_parser = subparsers.add_parser("api-key")
    api_key_subparsers = api_key_parser.add_subparsers(dest="api_key_command", required=True)

    create = api_key_subparsers.add_parser("create")
    create.add_argument("--tenant", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--scope", action="append", default=[])
    create.add_argument("--expires-at")
    create.add_argument("--created-by", required=True)

    list_command = api_key_subparsers.add_parser("list")
    list_command.add_argument("--tenant", required=True)

    revoke = api_key_subparsers.add_parser("revoke")
    revoke.add_argument("key_id")
    revoke.add_argument("--tenant", required=True)
    revoke.add_argument("--revoked-by", required=True)

    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    service: ApiKeyService | None = None,
    out=sys.stdout,
    err=sys.stderr,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if service is None:
        print("No ApiKeyStore runtime configured. Inject a configured ApiKeyService.", file=err)
        return 2

    if args.command != "api-key":
        parser.error("unknown command")

    if args.api_key_command == "create":
        expires_at = _parse_datetime(args.expires_at) if args.expires_at else None
        created = service.create_api_key(
            tenant_id=args.tenant,
            name=args.name,
            scopes=tuple(args.scope),
            expires_at=expires_at,
            created_by=args.created_by,
        )
        print("WARNING: save this secret now. It will only be shown once.", file=err)
        _write_line(out, f"id: {created.id}")
        _write_line(out, f"name: {created.name}")
        _write_line(out, f"prefix: {created.prefix}")
        _reveal_secret_once(out, created.secret)
        return 0

    if args.api_key_command == "list":
        for item in service.list_api_keys(tenant_id=args.tenant):
            state = "revoked" if item.revoked_at else "active"
            print(
                f"{item.id}\t{item.name}\t{item.key_prefix}\t{','.join(item.scopes)}\t{state}",
                file=out,
            )
        return 0

    revoked = service.revoke_api_key(
        tenant_id=args.tenant,
        key_id=args.key_id,
        revoked_by=args.revoked_by,
    )
    if revoked is None:
        print("API key not found for tenant.", file=err)
        return 1
    _write_line(out, f"revoked: {revoked.id}")
    return 0


def _parse_datetime(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def _write_line(out, value: str) -> None:
    out.write(f"{value}\n")


def _reveal_secret_once(out, secret: str) -> None:
    out.write("secret: ")
    out.write(secret)
    out.write("\n")
