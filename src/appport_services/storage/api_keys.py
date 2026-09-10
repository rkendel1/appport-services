from __future__ import annotations

from datetime import datetime
from typing import Protocol

from appport_services.api_keys.models import ApiKey


class ApiKeyStore(Protocol):
    def create(self, api_key: ApiKey) -> None: ...

    def get(self, key_id: str) -> ApiKey | None: ...

    def find_by_prefix(self, key_prefix: str) -> ApiKey | None: ...

    def list(self, tenant_id: str) -> list[ApiKey]: ...

    def revoke(self, key_id: str, *, revoked_at: datetime) -> ApiKey: ...

    def record_last_used(self, key_id: str, *, last_used_at: datetime) -> None: ...


class AuditSink(Protocol):
    def record(self, event_type: str, metadata: dict[str, str]) -> None: ...
