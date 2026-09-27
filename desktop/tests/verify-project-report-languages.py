"""Inspect and render the four synthetic reports emitted by the Rust language test."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument("samples", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
renderer = os.environ.get("ZENTRA_PDFTOPPM") or shutil.which("pdftoppm")
if not renderer:
    raise SystemExit("Set ZENTRA_PDFTOPPM to the Poppler pdftoppm executable.")
args.output.mkdir(parents=True, exist_ok=True)
expected = {
    "fr": ("suite", "Aucune donnée enregistrée"),
    "de": ("Fortsetzung", "Keine Daten erfasst"),
    "it": ("continua", "Nessun dato registrato"),
    "en": ("continued", "No data recorded"),
}
proof = []
for language, (continuation, empty) in expected.items():
    source = args.samples / f"rapport-{language}.pdf"
    document = PdfReader(source)
    texts = [page.extract_text() for page in document.pages]
    assert len(texts) > 1, (source, "No continuation page")
    assert empty in "\n".join(texts), (source, "Empty section has the wrong language")
    for text in texts[1:]:
        assert continuation in text, (source, "Wrong continuation label")
        assert "PROJET CLIENT" in text and "CLIENT SA" in text
        if language != "fr":
            assert "suite" not in text
    text = "\n".join(texts)
    assert "REFERENCE-7500-CHF" in text
    for number in range(65):
        assert text.count(f"CLIENT-{number:03}") == 1, (source, number, "Lost/duplicated record")
    characters = 0
    with pdfplumber.open(source) as pdf:
        for page_number, page in enumerate(pdf.pages, 1):
            for char in page.chars:
                if char["text"].strip():
                    assert 15 <= char["x0"] < char["x1"] <= page.width - 15, (source, page_number, "horizontal", char)
                    assert 15 <= char["top"] < char["bottom"] <= page.height - 15, (source, page_number, "vertical", char)
                    characters += 1
    prefix = args.output / f"rapport-{language}"
    subprocess.run([renderer, "-r", "90", "-png", str(source), str(prefix)], check=True, capture_output=True)
    pictures = sorted(args.output.glob(f"rapport-{language}-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
    assert len(pictures) == len(texts)
    for offset in range(0, len(pictures), 4):
        sheet = Image.new("RGB", (1600, 1240), "#e5e8e6")
        label = ImageDraw.Draw(sheet)
        for cell, path in enumerate(pictures[offset:offset + 4]):
            with Image.open(path) as raw:
                picture = raw.convert("RGB")
            picture.thumbnail((780, 570))
            x, y = (cell % 2) * 800, (cell // 2) * 620
            label.text((x + 12, y + 8), path.name, fill="#193128")
            sheet.paste(picture, (x + (800 - picture.width) // 2, y + 35))
        sheet.save(args.output / f"rapport-{language}-sheet-{offset // 4 + 1}.jpg", quality=92)
    proof.append({"language": language, "pages": len(texts), "records": 65,
                  "charactersWithinPage": characters, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
root = Path(__file__).resolve().parents[2]
sources = ["desktop/src-tauri/src/project_report.rs", "desktop/src-tauri/src/document_composition.rs", "desktop/src/projectReport.ts"]
result = {"synthetic": True, "nativeRustRender": True, "installedApplicationTested": False,
          "sources": {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in sources},
          "reports": proof, "visualReview": "separate"}
(args.output / "proof.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({"reports": len(proof), "pages": sum(row["pages"] for row in proof), "records": 65 * len(proof)}))
