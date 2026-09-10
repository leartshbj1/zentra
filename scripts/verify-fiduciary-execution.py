"""Verify actual native acceptance artifacts without recalculating the expectations.

Usage: python scripts/verify-fiduciary-execution.py OUTPUT_DIRECTORY
Checks the independent oracle, linked journal/ledger/statement outputs, the exact
closing ZIP members, and native PDF metadata. Visual and XSD review stay separate.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

from pypdf import PdfReader


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(output):
    def read(name):
        return json.loads((output / name).read_text(encoding="utf-8"))

    expected_path = Path(__file__).resolve().parent.parent / "docs/recette-fiduciaire/attendus.json"
    expected = json.loads(expected_path.read_text(encoding="utf-8"))["ledger_case"]
    comparison = read("comparaison.json")
    assert comparison["actual"] == comparison["expected"] == expected
    assert comparison["equal"] is True
    provenance = read("provenance.json")
    assert provenance["synthetic"] and not provenance["professional_approval"]
    assert provenance["source_hash_newlines"] == "LF"
    assert provenance["expected_sha256"] == digest(expected_path.read_bytes().replace(b"\r\n", b"\n"))
    source = expected_path.parents[2] / "desktop/src-tauri/src/fiduciary_acceptance.rs"
    assert provenance["harness_sha256"] == digest(source.read_bytes().replace(b"\r\n", b"\n"))
    operations = read("operations.json")
    assert operations["payment"]["id"]
    assert operations["payment"]["id"] == operations["payment_replay"]["id"]
    assert operations["payment"]["journal_entry_id"] == operations["payment_replay"]["journal_entry_id"]

    balance, income, bank = read("bilan.json"), read("resultat.json"), read("grand-livre-banque.json")
    assert balance["balanced"] and read("balance-comptes.json")["balanced"]
    assert balance["assets_cents"] == expected["assets_with_vat_unoffset"]
    assert income["profit_cents"] == expected["profit_before_tax"]
    assert income["sections"]["cost_of_goods"] == expected["purchases_net"]
    assert bank["net_debit_cents"] == expected["bank"]
    assert read("continuite.json")["total_anomalies"] == 0
    for name in ("ar", "supplier_payable"):
        assert read(f"grand-livre-{name}.json")["net_debit_cents"] == 0
    vat = read("tva-apercu.json")
    assert vat["exportable"] and not vat["blocking_issues"]
    assert vat["payable_tax_cents"] == expected["vat_payable"]
    assert read("tva-export.json")["xml_sha256"] == digest((output / "tva-2026-T1.xml").read_bytes())

    with zipfile.ZipFile(output / "dossier-cloture-provisoire.zip") as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate ZIP member"
        assert all(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts for name in names)
        sums = dict(line.split("  ", 1)[::-1] for line in archive.read("SHA256SUMS").decode().splitlines())
        assert set(sums) == set(names) - {"SHA256SUMS"}, "Every delivered member must be checked"
        for name, checksum in sums.items():
            assert digest(archive.read(name)) == checksum, name
        assert json.loads(archive.read("01_comptabilite/bilan.json")) == balance
        assert json.loads(archive.read("01_comptabilite/resultat.json")) == income
        journal = read("journal.json")
        exported_journal = json.loads(archive.read("01_comptabilite/journal.json"))
        assert journal["currency"]["single_currency"]
        assert exported_journal["currency"] == journal["currency"]["base_currency"] == "CHF"
        assert len(journal["entries"]) == 9 and len(journal["lines"]) == 22
        for collection in ("entries", "lines"):
            source = {row["id"]: row for row in journal[collection]}
            exported = {row["id"]: row for row in exported_journal[collection]}
            assert len(source) == len(journal[collection])
            assert len(exported) == len(exported_journal[collection])
            assert source.keys() == exported.keys()
            for record_id, row in source.items():
                # Only this UI action hint is absent from the archive's raw rows.
                for key, value in row.items():
                    if collection == "entries" and key == "reversal_action":
                        continue
                    assert exported[record_id][key] == value, (collection, record_id, key)
        for entry in journal["entries"]:
            lines = [line for line in journal["lines"] if line["journal_entry_id"] == entry["id"]]
            assert sum(line["debit_cents"] for line in lines) == sum(line["credit_cents"] for line in lines)
    assert read("cloture-export.json")["package_status"] == "DRAFT"
    closing_checks = read("pre-cloture.json")["checks"]
    assert closing_checks["attachments_total"] == closing_checks["attachments_verified"] == 1
    supplier_input = output / "pieces-fournisseur-fictives.pdf"
    supplier_fixture = expected_path.parent / "fixtures/pieces-fournisseur-fictives.pdf"
    assert supplier_input.read_bytes() == supplier_fixture.read_bytes()
    assert len(PdfReader(supplier_input).pages) == 2
    imported = read("justificatif-fournisseur-import.json")
    assert imported["entity_type"] == "supplier_invoice"
    assert imported["sha256"] == digest(supplier_input.read_bytes())
    assert imported["size_bytes"] == supplier_input.stat().st_size

    pdfs = []
    for name, metadata in (
        ("facture-fictive.pdf", "facture-fictive.pdf.json"),
        ("avoir-fictif.pdf", "avoir-fictif.pdf.json"),
        ("comptes-annuels-fictifs.pdf", "comptes-annuels-export.json"),
    ):
        data = (output / name).read_bytes()
        reader = PdfReader(output / name)
        exported = read(metadata)
        assert len(reader.pages) == exported["pages"], name
        assert all(page.extract_text().strip() for page in reader.pages), name
        assert "fictive" in " ".join(page.extract_text() for page in reader.pages).lower(), name
        if "sha256" in exported:
            assert exported["sha256"] == digest(data), name
        pdfs.append({"name": name, "pages": len(reader.pages), "sha256": digest(data)})
    proof = {"verified": True, "case": "ledger_case", "comparison": comparison,
             "pdfs": pdfs, "zip_members_checked": len(names), "professional_approval": False,
             "scope": "Native API and file consistency only; visual, XSD and professional review are separate."}
    (output / "verification-fichiers.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
    return proof


if __name__ == "__main__":
    print(json.dumps(verify(Path(sys.argv[1]).resolve()), ensure_ascii=False, indent=2))
