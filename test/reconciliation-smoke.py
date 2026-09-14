"""Offline smoke for unchanged vendored Antom scripts using synthetic data only.

Run: python3 -B test/reconciliation-smoke.py
No CDN requests, Antom CLI, credentials, dependency installation, or business APIs.
This validates file parsing and arithmetic, not a merchant reconciliation workflow.
"""

import csv
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from decimal import Decimal

sys.dont_write_bytecode = True


def deny_external_operations(event, args):
    if event in {
        "socket.connect",
        "socket.connect_ex",
        "socket.getaddrinfo",
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.posix_spawn",
    }:
        raise RuntimeError(f"Offline smoke forbids external operation: {event}")


sys.addaudithook(deny_external_operations)
SKILL_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "antom-reconciliation-expert"
sys.path.insert(0, str(SKILL_ROOT))

from scripts.core.parser import ReportTypeError, parse_reports  # noqa: E402
from scripts.core.validators import validate_batch_formula  # noqa: E402


HEADERS = [
    "settlementBatchId",
    "transactionId",
    "transactionRequestId",
    "transactionType",
    "paymentMethodType",
    "transactionAmountValue",
    "transactionCurrency",
    "settlementAmountValue",
    "settlementCurrency",
    "settlementInitiatedDate",
    "paymentMethodFeeAmountValue",
]
ROWS = [
    ["SYNTHETIC-BATCH", "SYNTHETIC-TX-1", "SYNTHETIC-REQ-1", "PAYMENT", "CARD",
     "100.00", "USD", "97.00", "USD", "2026-01-01", "-3.00"],
    ["SYNTHETIC-BATCH", "SYNTHETIC-TX-2", "SYNTHETIC-REQ-2", "PAYMENT", "CARD",
     "50.00", "USD", "48.50", "USD", "2026-01-01", "-1.50"],
]


class ReconciliationOfflineSmoke(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="antom-reconciliation-smoke-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def make_csv(self, name="SETTLEMENT_DETAIL_SYNTHETIC.csv", headers=None, rows=None):
        target = self.directory / name
        with target.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(HEADERS if headers is None else headers)
            writer.writerows(ROWS if rows is None else rows)
        return target

    def assert_parsed_and_balanced(self, target):
        parsed = parse_reports(str(target))
        self.assertTrue(parsed["success"])
        self.assertFalse(parsed["partial_success"])
        self.assertEqual(parsed["metadata"]["success_files"], 1)
        self.assertEqual(parsed["metadata"]["data_rows"], 2)
        self.assertEqual(parsed["fee_summary"]["total_fees"], "-4.50")
        validation = validate_batch_formula(parsed["data"])
        self.assertTrue(validation["all_valid"])
        self.assertEqual(validation["formula_valid_count"], 2)
        self.assertEqual(validation["net_settlement"], Decimal("145.50"))
        return parsed

    def test_synthetic_csv_parsing_and_validation(self):
        self.assert_parsed_and_balanced(self.make_csv())

    @unittest.skipUnless(importlib.util.find_spec("openpyxl"), "openpyxl is not installed")
    def test_synthetic_xlsx_parsing_and_validation(self):
        from openpyxl import Workbook

        target = self.directory / "SETTLEMENT_DETAIL_SYNTHETIC.xlsx"
        workbook = Workbook()
        workbook.active.append(HEADERS)
        for row in ROWS:
            workbook.active.append(row)
        workbook.save(target)
        workbook.close()
        self.assert_parsed_and_balanced(target)

    def test_changed_amount_produces_explicit_validation_failure(self):
        parsed = self.assert_parsed_and_balanced(self.make_csv())
        parsed["data"][0]["settlementAmountValue"] = "96.00"
        validation = validate_batch_formula(parsed["data"])
        self.assertFalse(validation["all_valid"])
        self.assertEqual(validation["formula_invalid_count"], 1)
        self.assertEqual(validation["validation_failures"][0]["diff"], Decimal("1.00"))

    def assert_rejected(self, target, kind):
        with self.assertRaises(ReportTypeError) as caught:
            parse_reports(str(target))
        self.assertEqual(caught.exception.kind, kind)

    def test_unsupported_extension_is_rejected(self):
        self.assert_rejected(self.make_csv("SETTLEMENT_DETAIL_SYNTHETIC.txt"), "extension")

    def test_non_settlement_filename_is_rejected(self):
        self.assert_rejected(self.make_csv("TRANSACTION_DETAIL_SYNTHETIC.csv"), "filename")

    def test_malformed_header_is_rejected(self):
        self.assert_rejected(self.make_csv(headers=["not", "a", "report"], rows=[]), "content")

    def test_renamed_transaction_detail_is_rejected(self):
        target = self.make_csv(headers=HEADERS + ["status"], rows=[row + ["SUCCESS"] for row in ROWS])
        self.assert_rejected(target, "content")


if __name__ == "__main__":
    availability = {name: importlib.util.find_spec(name) is not None
                    for name in ("openpyxl", "requests", "jsonschema")}
    print(f"Offline smoke dependency availability: {availability}", flush=True)
    print("Missing requests/jsonschema does not prevent the basic CSV arithmetic checks; "
          "CDN and DSL validation are not exercised.", flush=True)
    unittest.main(verbosity=2)
