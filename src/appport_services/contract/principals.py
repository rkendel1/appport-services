from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class AuthenticatedPrincipal:
    principal_id: str
    principal_type: str
    tenant_id: str
    scopes: tuple[str, ...]
    credential_id: str


class AuthorizationAdapter(Protocol):
    def authorize(
        self,
        *,
        principal: AuthenticatedPrincipal,
        resource: str,
        action: str,
    ) -> bool: ...
