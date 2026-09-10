from __future__ import annotations

from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timezone
import hashlib
import hmac
import secrets
from uuid import uuid4

from appport_services.api_keys.models import ApiKey, ApiKeyCreated, ApiKeyView
from appport_services.contract.principals import AuthenticatedPrincipal
from appport_services.storage.api_keys import ApiKeyStore, AuditSink

_SCHEME = "app_live"
_SALT_BYTES = 16
_SECRET_BYTES = 32


class ApiKeyService:
    def __init__(
        self,
        *,
        store: ApiKeyStore,
        audit_sink: AuditSink,
        now: callable | None = None,
        token_bytes: int = _SECRET_BYTES,
    ) -> None:
        self._store = store
        self._audit_sink = audit_sink
        self._now = now or self._utcnow
        self._token_bytes = token_bytes

    def create_api_key(
        self,
        *,
        tenant_id: str,
        name: str,
        scopes: tuple[str, ...] | list[str],
        expires_at: datetime | None,
        created_by: str,
    ) -> ApiKeyCreated:
        created_at = self._now()
        prefix = f"{_SCHEME}_{secrets.token_hex(3)}"
        secret_material = secrets.token_urlsafe(self._token_bytes)
        secret = f"{prefix}_{secret_material}"
        record = ApiKey(
            id=str(uuid4()),
            tenant_id=tenant_id,
            name=name,
            key_prefix=prefix,
            secret_hash=self._hash_secret(secret),
            scopes=tuple(scopes),
            created_at=created_at,
            expires_at=expires_at,
            revoked_at=None,
            last_used_at=None,
            created_by=created_by,
        )
        self._store.create(record)
        self._audit_sink.record(
            "api_key.created",
            {
                "credential_id": record.id,
                "tenant_id": tenant_id,
                "principal_id": created_by,
                "timestamp": created_at.isoformat(),
                "result": "success",
            },
        )
        return ApiKeyCreated(
            id=record.id,
            name=record.name,
            prefix=record.key_prefix,
            secret=secret,
        )

    def list_api_keys(self, *, tenant_id: str) -> list[ApiKeyView]:
        return [self._to_view(record) for record in self._store.list(tenant_id)]

    def get_api_key(self, *, tenant_id: str, key_id: str) -> ApiKeyView | None:
        record = self._store.get(key_id)
        if record is None or record.tenant_id != tenant_id:
            return None
        return self._to_view(record)

    def revoke_api_key(
        self,
        *,
        tenant_id: str,
        key_id: str,
        revoked_by: str,
    ) -> ApiKeyView | None:
        record = self._store.get(key_id)
        if record is None or record.tenant_id != tenant_id:
            return None

        revoked_at = record.revoked_at or self._now()
        revoked = self._store.revoke(key_id, revoked_at=revoked_at)
        self._audit_sink.record(
            "api_key.revoked",
            {
                "credential_id": revoked.id,
                "tenant_id": revoked.tenant_id,
                "principal_id": revoked_by,
                "timestamp": revoked_at.isoformat(),
                "result": "success",
            },
        )
        return self._to_view(revoked)

    def authenticate_api_key(self, secret: str) -> AuthenticatedPrincipal | None:
        prefix = self._parse_prefix(secret)
        if prefix is None:
            return None

        record = self._store.find_by_prefix(prefix)
        if record is None:
            return None

        now = self._now()
        if record.revoked_at is not None:
            self._audit_auth(record=record, timestamp=now, result="revoked")
            return None
        if record.expires_at is not None and record.expires_at <= now:
            self._audit_auth(record=record, timestamp=now, result="expired")
            return None
        if not self._verify_secret(secret, record.secret_hash):
            self._audit_auth(record=record, timestamp=now, result="invalid_secret")
            return None

        self._store.record_last_used(record.id, last_used_at=now)
        self._audit_auth(record=record, timestamp=now, result="success")
        return AuthenticatedPrincipal(
            principal_id=record.id,
            principal_type="api_key",
            tenant_id=record.tenant_id,
            scopes=record.scopes,
            credential_id=record.id,
        )

    @staticmethod
    def _utcnow() -> datetime:
        return datetime.now(timezone.utc)

    def _audit_auth(self, *, record: ApiKey, timestamp: datetime, result: str) -> None:
        self._audit_sink.record(
            "api_key.authenticated",
            {
                "credential_id": record.id,
                "tenant_id": record.tenant_id,
                "principal_id": record.id,
                "timestamp": timestamp.isoformat(),
                "result": result,
            },
        )

    @staticmethod
    def _to_view(record: ApiKey) -> ApiKeyView:
        return ApiKeyView(
            id=record.id,
            tenant_id=record.tenant_id,
            name=record.name,
            key_prefix=record.key_prefix,
            scopes=record.scopes,
            created_at=record.created_at,
            expires_at=record.expires_at,
            revoked_at=record.revoked_at,
            last_used_at=record.last_used_at,
            created_by=record.created_by,
        )

    @staticmethod
    def _parse_prefix(secret: str) -> str | None:
        parts = secret.split("_", 3)
        if len(parts) != 4:
            return None
        if parts[0] != "app" or parts[1] != "live" or not parts[2] or not parts[3]:
            return None
        return "_".join(parts[:3])

    @staticmethod
    def _hash_secret(secret: str) -> str:
        salt = secrets.token_bytes(_SALT_BYTES)
        derived = hashlib.scrypt(
            secret.encode("utf-8"),
            salt=salt,
            n=2**14,
            r=8,
            p=1,
            dklen=32,
        )
        return "scrypt$%s$%s" % (
            urlsafe_b64encode(salt).decode("ascii"),
            urlsafe_b64encode(derived).decode("ascii"),
        )

    @staticmethod
    def _verify_secret(secret: str, encoded_hash: str) -> bool:
        try:
            algorithm, salt_b64, digest_b64 = encoded_hash.split("$", 2)
        except ValueError:
            return False
        if algorithm != "scrypt":
            return False
        salt = urlsafe_b64decode(salt_b64.encode("ascii"))
        expected = urlsafe_b64decode(digest_b64.encode("ascii"))
        derived = hashlib.scrypt(
            secret.encode("utf-8"),
            salt=salt,
            n=2**14,
            r=8,
            p=1,
            dklen=len(expected),
        )
        return hmac.compare_digest(derived, expected)
