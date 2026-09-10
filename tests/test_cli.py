from __future__ import annotations

from datetime import datetime, timezone
from io import StringIO
import tempfile
import unittest

from helpers import ROOT  # noqa: F401

from appport_services.api_keys.service import ApiKeyService
from appport_services.runtime.cli import main
from test_api_keys_service import InMemoryTestStore, RecordingAuditSink


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = ApiKeyService(
            store=InMemoryTestStore(),
            audit_sink=RecordingAuditSink(),
            now=lambda: datetime(2026, 1, 2, tzinfo=timezone.utc),
        )

    def test_create_warns_secret_is_only_shown_once(self) -> None:
        out = tempfile.TemporaryFile(mode="w+")
        err = StringIO()

        with out:
            code = main(
                [
                    "api-key",
                    "create",
                    "--tenant",
                    "tenant-a",
                    "--name",
                    "production",
                    "--scope",
                    "invoices.read",
                    "--created-by",
                    "ops-1",
                ],
                service=self.service,
                out=out,
                err=err,
            )
            out.seek(0)
            rendered = out.read()

        self.assertEqual(code, 0)
        self.assertIn("only be shown once", err.getvalue())
        self.assertIn("secret: app_live_", rendered)

    def test_missing_runtime_configuration_fails_cleanly(self) -> None:
        out = StringIO()
        err = StringIO()

        code = main(["api-key", "list", "--tenant", "tenant-a"], out=out, err=err)

        self.assertEqual(code, 2)
        self.assertIn("No ApiKeyStore runtime configured", err.getvalue())
