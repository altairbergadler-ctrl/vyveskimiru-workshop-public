"""Build a self-hosted Cyrillic catalogue from the official Google Fonts repo.

The shipped TTFs are byte-for-byte official originals. This avoids creating
renamed derivatives of families with Reserved Font Names. Variable fonts stay
variable; the catalogue's weight is applied by the browser. Install fonttools
before running. A cache makes retries resumable.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

try:
    from fontTools.ttLib import TTFont
except ImportError:
    dependency_path = Path.home() / "AppData/Local/Temp/font-gallery-deps-20261012"
    sys.path.insert(0, str(dependency_path))
    from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "dist/assets"
SOURCES = ROOT / "source-fonts"
CACHE = SOURCES / "metadata"
GOOGLE_METADATA_URL = "https://fonts.google.com/metadata/fonts"
TREE_URL = "https://api.github.com/repos/google/fonts/git/trees/main?recursive=1"
RUSSIAN = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя"
USER_AGENT = "VyveskiMiru-FontCatalogue/1.0 (local licensed font mirror)"
CATEGORY_TAGS = {"Sans Serif": "Без засечек", "Serif": "С засечками",
                 "Handwriting": "Рукописные", "Display": "Декоративные",
                 "Monospace": "Моноширинные"}


def fetch(url: str, cache_path: Path | None = None) -> bytes:
    if cache_path and cache_path.is_file():
        return cache_path.read_bytes()
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=65) as response:
                data = response.read()
            if cache_path:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = cache_path.with_suffix(cache_path.suffix + ".tmp")
                temporary.write_bytes(data)
                temporary.replace(cache_path)
            return data
        except Exception:
            if attempt == 3:
                raise
            time.sleep(0.75 * (attempt + 1))
    raise AssertionError("unreachable")


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def identifier(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def choose_weight(family: dict) -> int:
    weights = [int(key) for key in family["fonts"] if key.isdigit()]
    return min(weights, key=lambda w: (abs(w - 700), -w))


def parse_font_blocks(metadata: str) -> list[dict]:
    blocks = []
    for body in re.findall(r"^fonts\s*\{(.*?)^\}", metadata, flags=re.MULTILINE | re.DOTALL):
        result = {}
        for key in ("name", "style", "filename", "copyright"):
            match = re.search(rf'^\s*{key}:\s*"(.*?)"', body, flags=re.MULTILINE)
            if match:
                result[key] = match.group(1)
        match = re.search(r"^\s*weight:\s*(\d+)", body, flags=re.MULTILINE)
        result["weight"] = int(match.group(1)) if match else 400
        if result.get("filename") and result.get("style") == "normal":
            blocks.append(result)
    return blocks


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def codepoint_ranges(codepoints: list[int]) -> list[list[int]]:
    ranges = []
    for codepoint in codepoints:
        if ranges and ranges[-1][1] + 1 == codepoint:
            ranges[-1][1] = codepoint
        else:
            ranges.append([codepoint, codepoint])
    return ranges


def add_tags(family: dict, weight: int, font: TTFont, description: str) -> tuple[list, list]:
    name = family["family"]
    tags = []
    evidence = []

    def add(tag: str, source: str):
        if tag not in tags:
            tags.append(tag)
            evidence.append({"tag": tag, "basis": source})

    add(CATEGORY_TAGS[family["category"]], "Google Fonts category: " + family["category"])
    classifications = family.get("classifications", [])
    if "Display" in classifications:
        add("Декоративные", "Google Fonts classification: Display")
    if "Handwriting" in classifications:
        add("Рукописные", "Google Fonts classification: Handwriting")
    if "Monospace" in classifications or "Mono" in name:
        add("Моноширинные", "Google Fonts classification or family name: Monospace/Mono")
    if weight >= 600:
        add("Жирные", "Selected font weight >= 600")
    width_class = font["OS/2"].usWidthClass if "OS/2" in font else 5
    if width_class < 5 or re.search(r"\b(Condensed|Narrow|Compressed)\b", name):
        add("Узкие", "Original OS/2 width class < 5 or explicit family name")
    if width_class > 5 or re.search(r"\b(Expanded|Extended|Wide)\b", name):
        add("Широкие", "Original OS/2 width class > 5 or explicit family name")
    text = re.sub(r"<[^>]+>", " ", html.unescape(description)).lower()
    if re.search(r"\b(?:narrow|condensed|compressed)\s+(?:grotesque|sans|typeface|font|design|family|letterforms)\b", text):
        add("Узкие", "Official family description explicitly describes narrow/condensed letterforms")
    if re.search(r"\b(?:wide|expanded)\s+(?:letterforms|letters|characters)\b|\bletterforms\s+are\s+wide\b", text):
        add("Широкие", "Official family description explicitly describes wide letterforms")
    if re.search(r"\bthick\s+strokes\b|\bstrokes\s+are\s+thick\b", text):
        add("Жирные", "Official family description explicitly describes thick strokes")
    if "geometric" in text and not re.search(r"(?:not|non[- ])\s*geometric", text):
        add("Геометрические", "Official family description contains geometric")
    if "rounded" in text or re.search(r"\b(Rounded|Round)\b", name):
        add("Округлые", "Official family description or explicit family name: rounded")
    return tags, evidence


def build_family(family: dict, directory: str, commit: str, repository_paths: set[str]) -> dict:
    name = family["family"]
    slug = identifier(name)
    raw_root = f"https://raw.githubusercontent.com/google/fonts/{commit}/"

    def source_url(path: str) -> str:
        return raw_root + quote(path, safe="/")

    metadata_path = directory + "/METADATA.pb"
    metadata_url = source_url(metadata_path)
    metadata = fetch(metadata_url, CACHE / slug / "METADATA.pb").decode("utf-8")
    blocks = parse_font_blocks(metadata)
    if not blocks:
        raise ValueError("No upright font in official METADATA.pb")
    desired = choose_weight(family)
    selected = min(blocks, key=lambda block: (abs(block["weight"] - desired), -block["weight"]))
    original_filename = selected["filename"]
    font_repository_path = directory + "/" + original_filename
    if font_repository_path not in repository_paths:
        raise ValueError("Font filename missing from pinned repository tree")

    license_candidates = [directory + "/" + file for file in ("OFL.txt", "LICENSE.txt", "LICENCE.txt", "LICENSE", "UFL.txt")]
    license_repository_path = next((p for p in license_candidates if p in repository_paths), None)
    if not license_repository_path:
        raise ValueError("No redistributable license file found")
    license_url = source_url(license_repository_path)
    license_bytes = fetch(license_url, CACHE / slug / "LICENSE.txt")
    license_text = license_bytes.decode("utf-8", errors="replace")
    if "SIL OPEN FONT LICENSE" in license_text:
        license_type = "SIL Open Font License 1.1"
    elif "Apache License" in license_text and "Version 2.0" in license_text:
        license_type = "Apache License 2.0"
    elif "UBUNTU FONT LICENCE" in license_text.upper() or "UBUNTU FONT LICENSE" in license_text.upper():
        license_type = "Ubuntu Font Licence 1.0"
    else:
        raise ValueError("License not recognized; do not publish")

    font_url = source_url(font_repository_path)
    original_suffix = Path(original_filename).suffix.lower()
    if original_suffix not in (".ttf", ".otf"):
        raise ValueError("Unsupported original font format")
    source_path = SOURCES / (slug + original_suffix)
    original_bytes = fetch(font_url, source_path)
    with TTFont(source_path, lazy=False) as font:
        cmap = font.getBestCmap() or {}
        codepoints = sorted(cp for cp, glyph in cmap.items() if glyph != ".notdef")
        missing = [char for char in RUSSIAN if ord(char) not in cmap or cmap[ord(char)] == ".notdef"]
        if missing:
            raise ValueError("Incomplete Russian alphabet: " + "".join(missing))
        variable_axes = []
        actual_weight = selected["weight"]
        if "fvar" in font:
            variable_axes = [{"tag": axis.axisTag, "min": axis.minValue, "max": axis.maxValue,
                              "default": axis.defaultValue} for axis in font["fvar"].axes]
            weight_axis = next((axis for axis in variable_axes if axis["tag"] == "wght"), None)
            if weight_axis:
                actual_weight = int(min(max(desired, weight_axis["min"]), weight_axis["max"]))
        description_path = directory + "/DESCRIPTION.en_us.html"
        description = ""
        if description_path in repository_paths:
            description = fetch(source_url(description_path), CACHE / slug / "DESCRIPTION.html").decode("utf-8")
        tags, tag_evidence = add_tags(family, actual_weight, font, description)
        units_per_em = font["head"].unitsPerEm
        cap_height = getattr(font["OS/2"], "sCapHeight", None) if "OS/2" in font else None

    assets_font_path = ASSETS / "fonts" / source_path.name
    assets_font_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, assets_font_path)
    assert sha(assets_font_path.read_bytes()) == sha(original_bytes), "Published font must be an unchanged original"
    license_file = ASSETS / "licenses" / (slug + ".txt")
    license_file.parent.mkdir(parents=True, exist_ok=True)
    license_file.write_bytes(license_bytes)
    return {
        "id": slug, "family": name, "weight": actual_weight, "style": "normal",
        "catalogPopularity": family.get("popularity"),
        "file": "assets/fonts/" + assets_font_path.name,
        "format": "truetype" if original_suffix == ".ttf" else "opentype",
        "category": family["category"], "tags": tags, "tagEvidence": tag_evidence,
        "supportedCodepoints": codepoints, "supportsRussian": True,
        "requiredGlyphs": {char: ord(char) in codepoints for char in "ЁёНП"},
        "license": {"type": license_type, "file": "assets/licenses/" + license_file.name,
                    "copyright": selected.get("copyright"),
                    "sourceUrl": license_url, "sha256": sha(license_bytes)},
        "sourceUrl": font_url, "metadataSourceUrl": metadata_url,
        "descriptionSourceUrl": source_url(description_path) if description else None,
        "sha256": sha(original_bytes), "originalSha256": sha(original_bytes),
        "bytes": len(original_bytes), "variableAxes": variable_axes,
        "unitsPerEm": units_per_em, "capHeight": cap_height,
        "manufacturingSuitability": None,
    }


def write_catalog(records: list[dict], commit: str, errors: list[dict]) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    sorted_records = sorted(records, key=lambda item: item["family"].casefold())
    compact_records = []
    for record in sorted_records:
        compact = {key: value for key, value in record.items()
                   if key not in ("supportedCodepoints", "tagEvidence")}
        compact["supportedRanges"] = codepoint_ranges(record["supportedCodepoints"])
        compact_records.append(compact)
    manifest = {
        "schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": GOOGLE_METADATA_URL,
        "repositoryUrl": "https://github.com/google/fonts", "repositoryCommit": commit,
        "fontCount": len(records), "russianAlphabetVerified": RUSSIAN,
        "fontDelivery": "Unmodified original full TTF/OTF, self-hosted; no Google requests from clients",
        "productionNote": "Наличие кириллицы и тегов не является проверкой пригодности к изготовлению.",
        "fonts": compact_records,
    }
    temporary = ASSETS / "font-catalog.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(ASSETS / "font-catalog.json")
    audit = dict(manifest)
    audit["fonts"] = sorted_records
    audit["buildErrors"] = errors
    qa_directory = ROOT / "qa"
    qa_directory.mkdir(parents=True, exist_ok=True)
    (qa_directory / "asset-verification.json").write_text(
        json.dumps(audit, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"fontCount": len(records), "totalBytes": sum(record["bytes"] for record in records),
              "errors": errors, "repositoryCommit": commit,
              "licenseCounts": {license_type: sum(x["license"]["type"] == license_type for x in records)
                                for license_type in sorted({x["license"]["type"] for x in records})}}
    (SOURCES / "build-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    raw_metadata = fetch(GOOGLE_METADATA_URL, CACHE / "google-fonts-metadata.json")
    metadata_text = raw_metadata.decode("utf-8")
    metadata = json.loads(metadata_text[metadata_text.find("{"):])
    tree_cache = CACHE / "repository-tree.json"
    preexisting_tree = Path.home() / "AppData/Local/Temp/font-gallery-google-tree.json"
    if not tree_cache.exists() and preexisting_tree.exists():
        shutil.copyfile(preexisting_tree, tree_cache)
    tree = json.loads(fetch(TREE_URL, tree_cache))
    if tree.get("truncated"):
        raise ValueError("GitHub repository tree truncated")
    commit = tree["sha"]
    paths = {item["path"] for item in tree["tree"] if item["type"] == "blob"}
    family_directories = {normalized(Path(path).parent.name): str(Path(path).parent).replace("\\", "/")
                          for path in paths if path.endswith("/METADATA.pb")}
    candidates = [family for family in metadata["familyMetadataList"]
                  if "cyrillic" in family["subsets"] and family.get("isOpenSource")
                  and family.get("primaryScript") not in ("Jpan", "Hant", "Hans", "Kore")
                  and "Symbols" not in family.get("classifications", [])]
    candidates.sort(key=lambda family: family["popularity"])
    candidates = candidates[:args.limit]
    print(f"Candidates: {len(candidates)}; pinned commit {commit}", flush=True)
    records, errors = [], []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {}
        for family in candidates:
            directory = family_directories.get(normalized(family["family"]))
            if not directory:
                errors.append({"family": family["family"], "error": "No official repository directory"})
                continue
            future = pool.submit(build_family, family, directory, commit, paths)
            futures[future] = family["family"]
        for future in as_completed(futures):
            family_name = futures[future]
            try:
                record = future.result()
                records.append(record)
                if len(records) <= 6 or len(records) % 10 == 0:
                    print(f"Verified {len(records)}: {family_name}; {record['bytes']} bytes", flush=True)
            except Exception as exc:
                errors.append({"family": family_name, "error": str(exc)})
                print(f"SKIP {family_name}: {exc}", flush=True)
            if len(records) <= 6 or len(records) % 10 == 0:
                write_catalog(records, commit, errors)
    write_catalog(records, commit, errors)
    print(json.dumps({"fonts": len(records), "errors": errors,
                      "totalMiB": round(sum(r["bytes"] for r in records) / 1048576, 2)},
                     ensure_ascii=False), flush=True)
    return 0 if len(records) >= 180 else 1


if __name__ == "__main__":
    raise SystemExit(main())
