"""Independently check the native deposit/bank acceptance artifacts.

Usage: python scripts/verify-fiduciary-deposit.py OUTPUT_DIRECTORY
This checks delivered data and PDF text, not professional approval, visual layout,
physical-device behavior or CAMT XSD/SPS conformance.
"""
import hashlib
import json
import sqlite3
import sys
import zipfile
from decimal import Decimal
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from pypdf import PdfReader


def digest(data):
    return hashlib.sha256(data).hexdigest()


def indexed(rows):
    result = {row["id"]: row for row in rows}
    assert len(result) == len(rows), "Duplicate record ID"
    return result


def check_journal(journal, entries, lines):
    assert len(journal["entries"]) == entries
    assert len(journal["lines"]) == lines
    entry_ids = indexed(journal["entries"])
    indexed(journal["lines"])
    assert all(line["journal_entry_id"] in entry_ids for line in journal["lines"])
    for identifier in entry_ids:
        posting = [line for line in journal["lines"] if line["journal_entry_id"] == identifier]
        assert len(posting) >= 2
        assert sum(line["debit_cents"] for line in posting) == sum(line["credit_cents"] for line in posting)
        assert sum(line["debit_cents"] for line in posting) > 0


def check_zip_names(archive):
    names = archive.namelist()
    assert len(names) == len(set(names))
    assert all(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts for name in names)
    return names


def verify(output):
    def read(name):
        return json.loads((output / name).read_text(encoding="utf-8"))

    root = Path(__file__).resolve().parent.parent
    oracle_path = root / "docs/recette-fiduciaire/attendus.json"
    expected = json.loads(oracle_path.read_text(encoding="utf-8"))["deposit_case"]
    comparison = read("comparaison.json")
    assert comparison["actual"] == comparison["expected"] == expected
    assert comparison["equal"] is True
    provenance = read("provenance.json")
    assert provenance["synthetic"] and not provenance["professional_approval"]
    assert provenance["advance_recognition_requires_professional_review"]
    assert not provenance["submission_to_afc"]
    assert provenance["source_hash_newlines"] == "LF"
    assert provenance["expected_sha256"] == digest(oracle_path.read_bytes().replace(b"\r\n", b"\n"))
    runner = root / "desktop/src-tauri/src/fiduciary_deposit_acceptance.rs"
    assert provenance["harness_sha256"] == digest(runner.read_bytes().replace(b"\r\n", b"\n"))

    workspace = read("donnees-metier-avant-cloture.json")
    assert len(workspace["quotes"]) == len(workspace["quote_invoice_pairs"]) == 1
    assert len(workspace["invoices"]) == len(workspace["payments"]) == 2
    pair = workspace["quote_invoice_pairs"][0]
    quote = workspace["quotes"][0]
    assert pair["quote_id"] == quote["id"]
    assert quote["total_cents"] == expected["quote_gross"]
    invoices = indexed(workspace["invoices"])
    deposit, balance = [invoices[pair[f"{role}_invoice_id"]] for role in ("deposit", "balance")]
    assert deposit["id"] != balance["id"] and deposit["number"] != balance["number"]
    assert deposit["total_cents"] == expected["deposit_gross"]
    assert balance["total_cents"] == expected["balance_gross"]
    assert deposit["total_cents"] + balance["total_cents"] == quote["total_cents"]
    assert deposit["vat_cents"] + balance["vat_cents"] == expected["total_vat"]
    for invoice in invoices.values():
        assert invoice["status"] == "payee"
        assert invoice["paid_cents"] == invoice["total_cents"]
        assert invoice["quote_id"] == quote["id"]
        assert invoice["project_id"] == quote["project_id"] and invoice["project_id"]
        items = [item for item in workspace["invoice_items"] if item["invoice_id"] == invoice["id"]]
        assert sum(item["line_total_cents"] for item in items) == invoice["total_cents"]
        assert sum(item["line_vat_cents"] for item in items) == invoice["vat_cents"]
    deductions = [item for item in workspace["invoice_items"] if item["invoice_id"] == balance["id"] and item["line_total_cents"] < 0]
    assert len(deductions) == 1
    assert deductions[0]["line_total_cents"] == -deposit["total_cents"]
    assert deductions[0]["line_vat_cents"] == -deposit["vat_cents"]
    after_deposit = read("apres-acompte.json")
    assert len(after_deposit["payments"]) == 1
    assert indexed(after_deposit["invoices"])[balance["id"]]["paid_cents"] == 0
    assert read("conversion-repetee-refusee.json")["unchanged"]

    references = read("references-factures.json")
    assert references["deposit"]["input"]["reference"] != references["balance"]["input"]["reference"]
    payments = indexed(workspace["payments"])
    bank = read("banque-apres-solde.json")
    assert len(bank["movements"]) == len(bank["reconciliations"]) == 2
    for role, invoice in (("deposit", deposit), ("balance", balance)):
        qr = references[role]
        assert qr["frozen"] and qr["reference_type"] == "SCOR"
        assert qr["invoice_id"] == invoice["id"]
        assert qr["input"]["amount_cents"] == invoice["total_cents"]
        reference = qr["input"]["reference"]
        # Independent ISO 11649 MOD-97 check of the frozen RF reference.
        expanded = "".join(str(ord(c) - 55) if c.isalpha() else c for c in reference[4:] + reference[:4])
        assert reference.startswith("RF") and int(expanded) % 97 == 1
        payment = next(row for row in payments.values() if row["invoice_id"] == invoice["id"])
        assert payment["amount_cents"] == invoice["total_cents"] and payment["reference"] == reference
        assert payment["journal_entry_semantically_valid"] and not payment["accounting_blocked"]
        movement = next(row for row in bank["movements"] if row["reconciliation"]["payment_id"] == payment["id"])
        assert movement["amount_cents"] == payment["amount_cents"]
        assert movement["reference"] == reference

    edge = "cas-bancaires-a-controler/"
    camt_results = []
    namespace = {"c": "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"}
    for prefix, name, amount, counts in (
        ("", "acompte", 32430, (1, 0, 0)), ("", "solde", 75670, (1, 0, 0)),
        (edge, "sans-reference", 10000, (0, 0, 1)), (edge, "partiel", 4000, (0, 1, 0)),
        (edge, "complement", 6000, (1, 0, 0)), (edge, "excedent", 12000, (0, 0, 1)),
    ):
        imported = read(f"{prefix}{name}-import.json")
        replay = read(f"{prefix}{name}-rejeu.json")
        data = (output / f"{prefix}camt-{name}.xml").read_bytes()
        assert imported["import"]["file_sha256"] == digest(data)
        assert imported["import"]["file_size"] == len(data)
        assert imported["imported_count"] == 1 and not imported["duplicate"]
        reconciliation = imported["automatic_reconciliation"]
        assert tuple(reconciliation[k] for k in ("paid_count", "partial_count", "review_count")) == counts
        assert reconciliation["failures"] == []
        assert replay["duplicate"] and replay["imported_count"] == 0
        assert replay["import"]["id"] == imported["import"]["id"]
        assert replay["automatic_reconciliation"]["paid_count"] == replay["automatic_reconciliation"]["partial_count"] == 0
        xml = ElementTree.fromstring(data)
        entries = xml.findall(".//c:Stmt/c:Ntry", namespace)
        assert len(entries) == 1
        assert Decimal(entries[0].find("c:Amt", namespace).text) * 100 == amount
        camt_results.append({"file": f"{prefix}camt-{name}.xml", "sha256": digest(data)})

    q1, q2 = read("journal-T1.json"), read("journal-T2-apres-avoir.json")
    check_journal(q1, 4, 10)
    check_journal(q2, 1, 3)
    assert read("grand-livre-banque.json")["net_debit_cents"] == expected["quote_gross"]
    assert read("grand-livre-clients.json")["net_debit_cents"] == 0
    assert read("resultat-T1.json")["revenue_cents"] == 100000
    assert read("tva-T1.json")["payable_tax_cents"] == expected["total_vat"]
    assert read("tva-T1.json")["exportable"]
    assert read("tva-T2-apres-avoir.json")["payable_tax_cents"] == -810
    review = read("pre-cloture.json")
    assert review["checks"]["ready_for_final"] and review["checks"]["audit_chain_valid"]
    assert review["checks"]["continuity"]["total_anomalies"] == 0
    assert read("cloture-T1.json")["period"]["status"] == "closed"
    with zipfile.ZipFile(output / "cloture-T1.zip") as archive:
        names = check_zip_names(archive)
        receipt = read("cloture-T1-export.json")
        assert len(names) == receipt["file_count"] == 19
        assert receipt["package_status"] == "FINAL"
        sums = dict(line.split("  ", 1)[::-1] for line in archive.read("SHA256SUMS").decode().splitlines())
        assert set(sums) == set(names) - {"SHA256SUMS"}
        for name, checksum in sums.items():
            assert digest(archive.read(name)) == checksum, name
        assert digest(archive.read("manifest.json")) == receipt["manifest_sha256"]
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["package_status"] == "FINAL"
        assert manifest["source_sha256"] == review["source_sha256"] == receipt["source_sha256"]
        assert {file["path"] for file in manifest["files"]} == set(names) - {"manifest.json", "SHA256SUMS"}
        for file in manifest["files"]:
            data = archive.read(file["path"])
            assert len(data) == file["size_bytes"] and digest(data) == file["sha256"]
        exported = json.loads(archive.read("01_comptabilite/journal.json"))
        for collection in ("entries", "lines"):
            source_rows, exported_rows = indexed(q1[collection]), indexed(exported[collection])
            assert source_rows.keys() == exported_rows.keys()
            for identifier, row in source_rows.items():
                for key, value in row.items():
                    if collection == "entries" and key == "reversal_action":
                        continue
                    assert exported_rows[identifier][key] == value

    unchanged = read("original-avant-apres-avoir.json")
    changes = {key for key in unchanged["before"].keys() | unchanged["after"].keys()
               if unchanged["before"].get(key) != unchanged["after"].get(key)}
    assert changes <= {"updated_at"}
    assert unchanged["before"]["snapshot_json"] == unchanged["after"]["snapshot_json"]
    refused = read("modifications-refusees.json")
    assert refused["unchanged"] and len(refused["errors"]) == 4 and all(refused["errors"])
    after = read("donnees-metier-apres-avoir.json")
    credit = next(row for row in after["invoices"] if row["type"] == "avoir")
    assert credit["total_cents"] == -10810 and credit["original_invoice_id"] == balance["id"]
    assert credit["issue_date"] == "2026-04-10"
    assert len(after["payments"]) == 2
    restored = read("restauration.json")
    assert all(restored[k] for k in ("restore_completed", "business_equal", "references_equal", "audit_valid"))
    assert restored["continuity_anomalies"] == 0
    with zipfile.ZipFile(output / "dossier-fictif.zentra") as archive:
        check_zip_names(archive)
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format_version"] == 2
        exports = [name for name in archive.namelist() if name.startswith("exports/")]
        assert len(exports) == 1
        assert archive.read(exports[0]) == (output / "cloture-T1.zip").read_bytes()
        database = sqlite3.connect(":memory:")
        try:
            database.deserialize(archive.read(manifest["database_file"]))
            database.row_factory = sqlite3.Row
            assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            for table, keys in (("invoices", ("id", "number", "snapshot_json", "total_cents", "paid_cents")),
                                ("payments", ("id", "invoice_id", "amount_cents", "reference", "date"))):
                saved = indexed([dict(row) for row in database.execute(f"SELECT {','.join(keys)} FROM {table}")])
                assert saved == {row["id"]: {key: row[key] for key in keys} for row in after[table]}
        finally:
            database.close()

    edge_workspace = read(edge + "donnees-metier-fictives.json")
    assert len(edge_workspace["invoices"]) == len(edge_workspace["payments"]) == 3
    assert sorted(row["amount_cents"] for row in edge_workspace["payments"]) == [4000, 6000, 10000]
    assert read(edge + "confirmation-manuelle.json")["payment"]["id"] == read(edge + "confirmation-manuelle-rejeu.json")["payment"]["id"]
    check_journal(read(edge + "journal.json"), 6, 12)
    partial = read(edge + "apres-paiement-partiel.json")
    assert partial["paid_cents"] == 4000 and partial["total_cents"] - partial["paid_cents"] == 6000
    unmatched = read(edge + "propositions-sans-reference.json")["movements"][0]
    assert unmatched["reconciliation"] is None and len(unmatched["suggestion"]["candidates"]) == 2
    excess = read(edge + "excedent-conserve-a-traiter.json")
    assert excess["money_preserved"] and not excess["split_payment_and_customer_credit_completed"]
    assert excess["bank_movement"]["amount_cents"] == 12000
    assert excess["bank_movement"]["reconciliation"] is None and excess["invoice"]["paid_cents"] == 0
    assert excess["excess_cents"] == 2000 and excess["manual_matching_error"]

    pdfs = []
    for name, tokens in (
        ("devis-fictif.pdf", (quote["number"], "1'081.00")),
        ("facture-acompte-fictive.pdf", (deposit["number"], "324.30", "ACOMPTE 30 %")),
        ("facture-solde-fictive.pdf", (balance["number"], deposit["number"], "756.70", "-300.00")),
        ("avoir-apres-cloture-fictif.pdf", (credit["number"], balance["number"], "-108.10")),
    ):
        reader = PdfReader(output / name)
        receipt = read(name + ".json")
        assert len(reader.pages) == receipt["pages"] == 1 and receipt["final_document"]
        text = " ".join(page.extract_text() for page in reader.pages)
        assert "fictive" in text and all(token in text for token in tokens), name
        role = {"facture-acompte-fictive.pdf": "deposit", "facture-solde-fictive.pdf": "balance"}.get(name)
        if role:
            assert references[role]["input"]["reference"] in "".join(text.split())
        pdfs.append({"name": name, "pages": len(reader.pages), "sha256": digest((output / name).read_bytes())})

    return {"artifact_checks_passed": True, "expected_amounts": expected,
            "journal_T1": {"entries": 4, "lines": 10}, "journal_T2": {"entries": 1, "lines": 3},
            "pdfs": pdfs, "camt_inputs": camt_results, "camt_schema_validated": False,
            "remaining_requirements": {
                "overpayment_allocation_and_customer_credit": True,
                "advance_revenue_recognition_review": True,
                "observed_january_revenue_cents": read("resultat-janvier-avant-prestation.json")["revenue_cents"],
                "professional_approval": True, "physical_device_and_UI_acceptance": True}}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/verify-fiduciary-deposit.py OUTPUT_DIRECTORY")
    print(json.dumps(verify(Path(sys.argv[1]).resolve()), ensure_ascii=True, indent=2))
