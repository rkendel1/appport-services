from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class ApiKey:
    id: str
    tenant_id: str
    name: str
    key_prefix: str
    secret_hash: str
    scopes: tuple[str, ...]
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_by: str


@dataclass(frozen=True)
class ApiKeyView:
    id: str
    tenant_id: str
    name: str
    key_prefix: str
    scopes: tuple[str, ...]
    created_at: datetime
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_by: str


@dataclass(frozen=True)
class ApiKeyCreated:
    id: str
    name: str
    prefix: str
    secret: str
