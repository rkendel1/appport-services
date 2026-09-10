from __future__ import annotations

from appport_services.api_keys.service import ApiKeyService
from appport_services.contract.principals import AuthenticatedPrincipal


def authenticate_bearer_token(
    authorization_header: str,
    service: ApiKeyService,
) -> AuthenticatedPrincipal | None:
    scheme, _, token = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return service.authenticate_api_key(token)
