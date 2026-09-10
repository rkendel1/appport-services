from __future__ import annotations

from datetime import datetime, timedelta, timezone
import inspect
import unittest

from helpers import ROOT  # noqa: F401

from appport_services.api_keys.models import ApiKey
from appport_services.api_keys.service import ApiKeyService
from appport_services.runtime.api_keys import authenticate_bearer_token


class InMemoryTestStore:
    def __init__(self) -> None:
        self.by_id: dict[str, ApiKey] = {}
        self.by_prefix: dict[str, str] = {}

    def create(self, api_key: ApiKey) -> None:
        self.by_id[api_key.id] = api_key
        self.by_prefix[api_key.key_prefix] = api_key.id

    def get(self, key_id: str) -> ApiKey | None:
        return self.by_id.get(key_id)

    def find_by_prefix(self, key_prefix: str) -> ApiKey | None:
        key_id = self.by_prefix.get(key_prefix)
        return self.by_id.get(key_id) if key_id else None

    def list(self, tenant_id: str) -> list[ApiKey]:
        return [record for record in self.by_id.values() if record.tenant_id == tenant_id]

    def revoke(self, key_id: str, *, revoked_at: datetime) -> ApiKey:
        record = self.by_id[key_id]
        revoked = ApiKey(
            id=record.id,
            tenant_id=record.tenant_id,
            name=record.name,
            key_prefix=record.key_prefix,
            secret_hash=record.secret_hash,
            scopes=record.scopes,
            created_at=record.created_at,
            expires_at=record.expires_at,
            revoked_at=revoked_at,
            last_used_at=record.last_used_at,
            created_by=record.created_by,
        )
        self.by_id[key_id] = revoked
        return revoked

    def record_last_used(self, key_id: str, *, last_used_at: datetime) -> None:
        record = self.by_id[key_id]
        self.by_id[key_id] = ApiKey(
            id=record.id,
            tenant_id=record.tenant_id,
            name=record.name,
            key_prefix=record.key_prefix,
            secret_hash=record.secret_hash,
            scopes=record.scopes,
            created_at=record.created_at,
            expires_at=record.expires_at,
            revoked_at=record.revoked_at,
            last_used_at=last_used_at,
            created_by=record.created_by,
        )


class RecordingAuditSink:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, str]]] = []

    def record(self, event_type: str, metadata: dict[str, str]) -> None:
        self.events.append((event_type, metadata))


class ApiKeyServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime(2026, 1, 2, tzinfo=timezone.utc)
        self.store = InMemoryTestStore()
        self.audit = RecordingAuditSink()
        self.service = ApiKeyService(
            store=self.store,
            audit_sink=self.audit,
            now=lambda: self.now,
        )

    def test_create_returns_secret_once_and_persists_hash(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read", "users.read"),
            expires_at=None,
            created_by="ops-1",
        )

        stored = self.store.get(created.id)
        self.assertIsNotNone(stored)
        assert stored is not None
        self.assertTrue(created.secret.startswith(f"{created.prefix}_"))
        self.assertNotEqual(stored.secret_hash, created.secret)
        self.assertTrue(stored.secret_hash.startswith("scrypt$"))
        self.assertNotIn(created.secret, repr(stored))
        self.assertEqual(stored.tenant_id, "tenant-a")
        self.assertEqual(stored.scopes, ("invoices.read", "users.read"))

    def test_get_and_list_never_return_raw_secret(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        fetched = self.service.get_api_key(tenant_id="tenant-a", key_id=created.id)
        listed = self.service.list_api_keys(tenant_id="tenant-a")

        self.assertIsNotNone(fetched)
        self.assertFalse(hasattr(fetched, "secret"))
        self.assertFalse(hasattr(fetched, "secret_hash"))
        self.assertEqual(len(listed), 1)
        self.assertFalse(hasattr(listed[0], "secret"))

    def test_authenticate_valid_secret_returns_machine_principal(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=self.now + timedelta(days=30),
            created_by="ops-1",
        )

        principal = self.service.authenticate_api_key(created.secret)

        self.assertIsNotNone(principal)
        assert principal is not None
        self.assertEqual(principal.principal_type, "api_key")
        self.assertEqual(principal.tenant_id, "tenant-a")
        self.assertEqual(principal.scopes, ("invoices.read",))
        self.assertEqual(principal.credential_id, created.id)
        self.assertEqual(self.store.get(created.id).last_used_at, self.now)

    def test_invalid_or_unknown_secret_fails(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        self.assertIsNone(self.service.authenticate_api_key(created.secret + "x"))
        self.assertIsNone(self.service.authenticate_api_key("app_live_missing_secret"))
        self.assertIsNone(self.service.authenticate_api_key("not-a-key"))

    def test_revoked_key_fails_and_revocation_persists(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        revoked = self.service.revoke_api_key(
            tenant_id="tenant-a",
            key_id=created.id,
            revoked_by="ops-2",
        )

        self.assertIsNotNone(revoked)
        self.assertIsNotNone(self.store.get(created.id).revoked_at)
        self.assertIsNone(self.service.authenticate_api_key(created.secret))

    def test_expired_key_fails(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=self.now - timedelta(seconds=1),
            created_by="ops-1",
        )

        self.assertIsNone(self.service.authenticate_api_key(created.secret))

    def test_cross_tenant_access_fails(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )
        other = self.service.create_api_key(
            tenant_id="tenant-b",
            name="other",
            scopes=("users.read",),
            expires_at=None,
            created_by="ops-2",
        )

        self.assertIsNone(self.service.get_api_key(tenant_id="tenant-b", key_id=created.id))
        self.assertIsNone(
            self.service.revoke_api_key(
                tenant_id="tenant-b",
                key_id=created.id,
                revoked_by="ops-2",
            )
        )
        self.assertEqual([item.id for item in self.service.list_api_keys(tenant_id="tenant-b")], [other.id])
        self.assertEqual([item.id for item in self.service.list_api_keys(tenant_id="tenant-a")], [created.id])

    def test_authenticate_signature_does_not_accept_tenant_override(self) -> None:
        parameters = inspect.signature(self.service.authenticate_api_key).parameters
        self.assertEqual(list(parameters), ["secret"])

    def test_audit_events_never_include_raw_secret(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        self.service.authenticate_api_key(created.secret)

        recorded_values = "".join(str(value) for _, metadata in self.audit.events for value in metadata.values())
        self.assertNotIn(created.secret, recorded_values)

    def test_bearer_adapter_returns_authenticated_principal(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        principal = authenticate_bearer_token("Bearer " + created.secret, self.service)

        self.assertIsNotNone(principal)
        assert principal is not None
        self.assertEqual(principal.principal_type, "api_key")

    def test_high_entropy_secret_generation(self) -> None:
        created = self.service.create_api_key(
            tenant_id="tenant-a",
            name="production",
            scopes=("invoices.read",),
            expires_at=None,
            created_by="ops-1",
        )

        self.assertGreaterEqual(len(created.secret), 40)

    @unittest.skip("Blocked pending a real FeltDB-backed ApiKeyStore adapter.")
    def test_restart_preserves_credentials_with_real_durable_store(self) -> None:
        raise NotImplementedError

    @unittest.skip("Blocked pending a real FeltDB-backed ApiKeyStore adapter.")
    def test_restart_then_revoke_then_restart_fails_authentication(self) -> None:
        raise NotImplementedError
