"""Local PDF placement engine. Public coordinates are rendered-page PDF points.

Stamp artwork is embedded unchanged; no image generation or recreation is used.
Automatic placement requires an exact, nearby INN and a unique blank position.
"""
from __future__ import annotations

import hashlib
import io
import math
import os
import random
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import fitz
from PIL import Image, ImageChops, ImageFilter

MARKER = "stamp-service:v1"
SCAN_MARKER = "stamp-service:simulated-scan:v1"
SCAN_MAX_PAGE_PIXELS = 24_000_000
SCAN_MAX_TOTAL_PIXELS = 200_000_000
SCAN_PROFILES = {
    "light": {"tone": (255, 254, 252), "light": 2, "blur": 0.12, "noise": 0.008, "skew": 0.06, "quality": 94},
    "standard": {"tone": (254, 253, 250), "light": 4, "blur": 0.22, "noise": 0.012, "skew": 0.12, "quality": 93},
    "strong": {"tone": (253, 251, 247), "light": 7, "blur": 0.35, "noise": 0.020, "skew": 0.20, "quality": 92},
}
MM_TO_PT = 72 / 25.4


def _reject_signed_document(doc: fitz.Document) -> None:
    # Scanning is also a document modification. Read-only previews may open a
    # signature, but raster exports must follow the same rule as stamping.
    if doc.get_sigflags() > 0:
        raise ValueError("PDF содержит электронную подпись или поле подписи. Загрузите неподписанную копию.")
    for index in range(1, doc.xref_length()):
        kind, value = doc.xref_get_key(index, "ByteRange")
        if kind == "array" and any(int(n) for n in re.findall(r"\d+", value)):
            raise ValueError("PDF содержит электронную подпись. Обработка изменит подписанный документ.")


def _open_document(path: str | Path, *, read_only: bool = False) -> fitz.Document:
    try:
        doc = fitz.open(path)
    except (RuntimeError, ValueError, OSError) as exc:
        raise ValueError("Не удалось открыть PDF: файл повреждён или имеет другой формат.") from exc
    try:
        if not doc.is_pdf:
            raise ValueError("Нужен документ в формате PDF.")
        if doc.needs_pass or doc.is_encrypted:
            raise ValueError("PDF защищён паролем. Загрузите копию без защиты.")
        if not len(doc):
            raise ValueError("В PDF нет страниц.")
        if len(doc) > 50:
            raise ValueError("В одном PDF допускается не более 50 страниц.")
        if doc.xref_length() > 200000:
            raise ValueError("PDF слишком сложный для обработки; сохраните упрощённую копию.")
        if any(max(page.rect.width, page.rect.height) > 5000 or min(page.rect.width, page.rect.height) <= 0
               for page in doc):
            raise ValueError("Недопустимый размер страницы PDF (максимум 5000 пунктов).")
        if not read_only and MARKER in (doc.metadata.get("keywords") or ""):
            raise ValueError("На этот документ уже поставлена печать этим инструментом. Загрузите исходный PDF.")
        # Even an unsigned signature form is refused conservatively: users must
        # explicitly prepare an unsigned copy outside this stamping workflow.
        if not read_only:
            _reject_signed_document(doc)
        return doc
    except Exception:
        doc.close()
        raise


def _plain(text: str) -> str:
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def _exact_inn(text: str, inn: str) -> bool:
    compact = re.sub(r"\s", "", text)
    return bool(re.search(r"(?<!\d)" + re.escape(inn) + r"(?!\d)", compact))


def _inn_line(text: str) -> bool:
    compact = re.sub(r"\s", "", text)
    return bool(re.search(r"(?<!\d)\d{10}(?:\d{2})?(?!\d)", compact)) and (
        "инн" in compact.casefold() or bool(re.search(r"\d{10}(?:\d{2})?/\d{9}", compact))
    )


def _lines(page: fitz.Page, textpage=None) -> list[dict[str, Any]]:
    output, groups = [], {}
    # Words avoid loading embedded scan-image bytes. Large gaps split columns
    # even when a PDF exporter records both companies as one text line/span.
    flags = fitz.TEXTFLAGS_WORDS & ~fitz.TEXT_PRESERVE_IMAGES
    for word in page.get_text("words", textpage=textpage, flags=flags):
        groups.setdefault((word[5], word[6]), []).append(word)
    for words in groups.values():
        words.sort(key=lambda item: item[7])
        current = []
        for word in words:
            if current and word[0] - current[-1][2] > 45:
                box = fitz.Rect(current[0][:4])
                for previous in current[1:]:
                    box |= fitz.Rect(previous[:4])
                output.append({"text": " ".join(item[4] for item in current), "rect": box})
                current = []
            current.append(word)
        if current:
            box = fitz.Rect(current[0][:4])
            for previous in current[1:]:
                box |= fitz.Rect(previous[:4])
            output.append({"text": " ".join(item[4] for item in current), "rect": box})
    return output


def _mp_labels(lines: list[dict]) -> list[dict]:
    # Matching whole lines avoids the numerous mentions of М.П. in footnotes.
    # Spaces, punctuation and Latin OCR lookalikes may split the two letters.
    labels = []
    for line in lines:
        value = _plain(line["text"]).replace("m", "м").replace("n", "п").replace("p", "п")
        if value == "мп":
            rect = line["rect"]
            if not any((rect & item["rect"]).get_area() > 0 for item in labels):
                labels.append(line)
    # Some exporters place the two letters in separate text objects.
    for first in lines:
        if _plain(first["text"]) not in ("м", "m"):
            continue
        for second in lines:
            if _plain(second["text"]) not in ("п", "p", "n"):
                continue
            a, b = first["rect"], second["rect"]
            if abs(a.y0 - b.y0) < 2 and -1 <= b.x0 - a.x1 <= max(8, a.height):
                rect = a | b
                if not any(rect.intersects(item["rect"]) for item in labels):
                    labels.append({"text": first["text"] + second["text"], "rect": rect})
    return labels


def _local_identity(label: dict, labels: list[dict], lines: list[dict], inn: str, name: str):
    """Associate company lines to the nearest *label*, never a fixed page side."""
    anchor = label["rect"]
    nearby = []
    for line in lines:
        box = line["rect"]
        vertical = anchor.y0 - box.y1
        if not -18 <= vertical <= 155 or not _inn_line(line["text"]):
            continue
        row_labels = [other for other in labels if abs(other["rect"].y0 - anchor.y0) < 45]
        distances = [abs(other["rect"].x0 - box.x0) for other in row_labels]
        current = abs(anchor.x0 - box.x0)
        if distances and current > min(distances) + 1:
            continue
        if current > 170:
            continue
        nearby.append((max(0, vertical) + current * 0.15, line))
    if nearby:
        nearby.sort(key=lambda pair: pair[0])
        best_score, best = nearby[0]
        matching = _exact_inn(best["text"], inn)
        # Near-tied identities for different companies are intentionally manual.
        ambiguous = any(score - best_score < 12 and _exact_inn(line["text"], inn) != matching
                        for score, line in nearby[1:])
        if ambiguous:
            return "ambiguous", best["text"]
        return ("inn" if matching else "other"), best["text"]
    normalized = _plain(name)
    if normalized:
        for line in lines:
            box = line["rect"]
            if normalized in _plain(line["text"]) and -18 <= anchor.y0 - box.y1 <= 155:
                if abs(anchor.x0 - box.x0) <= 170:
                    others = [abs(other["rect"].x0 - box.x0) for other in labels
                              if abs(other["rect"].y0 - anchor.y0) < 45]
                    if not others or abs(anchor.x0 - box.x0) <= min(others) + 1:
                        return "name", line["text"]
    return "unknown", ""


def _gray_preview(page: fitz.Page):
    scale = min(1.3, 1300 / max(page.rect.width, page.rect.height))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    return Image.frombytes("L", (pix.width, pix.height), pix.samples), scale


def _blank_position(page: fitz.Page, label: fitz.Rect, width: float, height: float,
                    occupied: list[fitz.Rect], preview) -> fitz.Rect | None:
    image, scale = preview
    page_box = page.rect
    choices = []
    # Test preferred adjacent positions before a small, bounded local search.
    positions = [(label.x1 + 8, label.y0 + 2),
                 (label.x1 + 8, label.y1 + 5),
                 (label.x0, label.y1 + 6),
                 (label.x0 - width - 8, label.y0 + 2),
                 (label.x0 - width - 8, label.y1 + 6)]
    for dx in (8, 20, 40, -width - 8, -width - 24):
        for dy in (2, 12, 24, 40, -height - 8):
            positions.append((label.x1 + dx if dx > 0 else label.x0 + dx, label.y0 + dy))
    for x, y in positions:
        rect = fitz.Rect(x, y, x + width, y + height)
        if rect.x0 < 5 or rect.y0 < 5 or rect.x1 > page_box.width - 5 or rect.y1 > page_box.height - 5:
            continue
        padded = rect + (-1.5, -1.5, 1.5, 1.5)
        if any(padded.intersects(box) for box in occupied):
            continue
        crop = image.crop((int(rect.x0 * scale), int(rect.y0 * scale),
                           int(math.ceil(rect.x1 * scale)), int(math.ceil(rect.y1 * scale))))
        histogram = crop.histogram()
        count = max(1, sum(histogram))
        # Printed lines, existing stamps and logos also count as occupied.
        dark_fraction = sum(histogram[:220]) / count
        if dark_fraction > 0.003:
            continue
        distance = math.hypot(max(0, rect.x0 - label.x1, label.x0 - rect.x1),
                              max(0, rect.y0 - label.y1, label.y0 - rect.y1))
        choices.append((distance + (0 if x >= label.x1 else 3) + abs(y - label.y0) * 0.03, rect))
    return min(choices, key=lambda item: item[0])[1] if choices else None


def inspect_pdf(pdf_path: str | Path, company_inn: str = "7700000000",
                company_name: str = "Тестовая компания", width_mm: float = 35.6,
                stamp_aspect: float = 1.00692, ocr: bool = False) -> dict:
    if not re.fullmatch(r"\d{10}|\d{12}", company_inn):
        raise ValueError("ИНН должен содержать 10 или 12 цифр.")
    if not math.isfinite(width_mm) or not 5 <= width_mm <= 100:
        raise ValueError("Ширина печати должна быть от 5 до 100 мм.")
    if not math.isfinite(stamp_aspect) or not 0.1 <= stamp_aspect <= 10:
        raise ValueError("Недопустимые пропорции изображения печати.")
    width = width_mm * MM_TO_PT
    # API profile aspect is height / width, matching the preview UI.
    height = width * stamp_aspect
    result = {"pages": [], "candidates": [], "warnings": [], "auto_candidate_index": None}
    with _open_document(pdf_path) as doc:
        any_label = False
        exact_company_seen = False
        for index, page in enumerate(doc):
            result["pages"].append({"index": index, "width": page.rect.width,
                                    "height": page.rect.height, "rotation": page.rotation})
            lines = _lines(page)
            source = "text"
            labels = _mp_labels(lines)
            exact_company_seen |= any(_exact_inn(line["text"], company_inn) for line in lines)
            # OCR only when no useful native label exists, and entirely locally.
            if ocr and not labels:
                try:
                    textpage = page.get_textpage_ocr(language="rus+eng", dpi=200, full=True)
                    lines = _lines(page, textpage)
                    labels = _mp_labels(lines)
                    source = "ocr"
                    exact_company_seen |= any(_exact_inn(line["text"], company_inn) for line in lines)
                except Exception:
                    result["warnings"].append(f"Страница {index + 1}: локальное OCR недоступно. Проверьте Tesseract и языки rus/eng.")
            if not labels:
                continue
            any_label = True
            occupied = [line["rect"] * page.rotation_matrix for line in lines]
            preview = _gray_preview(page)
            for label in labels:
                identity, identity_text = _local_identity(label, labels, lines, company_inn, company_name)
                if identity == "other":
                    continue
                display_label = label["rect"] * page.rotation_matrix
                box = _blank_position(page, display_label, width, height, occupied, preview)
                if box is None:
                    result["warnings"].append(f"Страница {index + 1}: рядом с М.П. нет свободного места для печати заданного размера; разместите вручную.")
                    continue
                confidence = {"inn": 0.98, "name": 0.6, "ambiguous": 0.3, "unknown": 0.25}[identity]
                reason = {"inn": "Отдельная отметка М.П. рядом с точным ИНН организации; найдено свободное место.",
                          "name": "Рядом есть название организации, но нет точного ИНН. Требуется проверка.",
                          "ambiguous": "Рядом указаны разные организации. Требуется ручная проверка.",
                          "unknown": "Найдена отметка М.П., принадлежность организации не подтверждена. Требуется проверка."}[identity]
                if source == "ocr":
                    confidence = min(confidence, 0.7)
                    reason += " Координаты получены OCR; проверьте по изображению."
                result["candidates"].append({"id": f"p{index}-c{len(result['candidates'])}",
                    "page": index, "x": box.x0, "y": box.y0, "width": width, "height": height,
                    "confidence": confidence, "reason": reason, "source": source,
                    "matched_identity": identity_text,
                    "anchor": {"x": display_label.x0, "y": display_label.y0,
                               "width": display_label.width, "height": display_label.height}})
        if not any_label:
            result["warnings"].append("Отдельная отметка М.П. не найдена. Укажите место вручную" +
                                      (" или включите OCR для скана." if not ocr else "."))
        if not exact_company_seen:
            result["warnings"].append("Точный ИНН организации в документе не найден. Автоматическая установка отключена.")
        eligible = [i for i, item in enumerate(result["candidates"])
                    if item["source"] == "text" and item["confidence"] >= 0.95]
        if len(eligible) == 1:
            result["auto_candidate_index"] = eligible[0]
        elif len(eligible) > 1:
            result["warnings"].append("Найдено несколько подходящих мест. Выберите нужную страницу и место вручную.")
        result["warnings"] = list(dict.fromkeys(result["warnings"]))
    return result


def render_page(pdf_path: str | Path, page_index: int, max_width: int = 1600) -> bytes:
    if not isinstance(max_width, int) or not 100 <= max_width <= 3000:
        raise ValueError("Недопустимый размер предпросмотра.")
    with _open_document(pdf_path, read_only=True) as doc:
        if not isinstance(page_index, int) or not 0 <= page_index < len(doc):
            raise ValueError("Страница PDF не найдена.")
        page = doc[page_index]
        scale = min(max_width / page.rect.width, 3000 / page.rect.height)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return pix.tobytes("png")


def stamp_pdf(pdf_path: str | Path, output_path: str | Path, stamp_path: str | Path,
              placement: dict) -> dict:
    if Path(pdf_path).resolve() == Path(output_path).resolve():
        raise ValueError("Результат нужно сохранить отдельным файлом, чтобы сохранить оригинал.")
    try:
        page_index = placement["page"]
        values = [float(placement[key]) for key in ("x", "y", "width", "height")]
        if isinstance(page_index, bool) or not isinstance(page_index, int) or not all(math.isfinite(v) for v in values):
            raise ValueError
        x, y, width, height = values
        if width <= 0 or height <= 0:
            raise ValueError
    except (KeyError, ValueError, TypeError) as exc:
        raise ValueError("Некорректные координаты печати.") from exc
    try:
        image_bytes = Path(stamp_path).read_bytes()
        with Image.open(stamp_path) as image:
            aspect = image.width / image.height
    except (OSError, ValueError) as exc:
        raise ValueError("Не удалось открыть изображение печати.") from exc
    if abs((width / height) / aspect - 1) > 0.01:
        raise ValueError("Пропорции печати изменены. Установите размер без растяжения изображения.")
    with _open_document(pdf_path) as doc:
        if not 0 <= page_index < len(doc):
            raise ValueError("Страница PDF не найдена.")
        page = doc[page_index]
        rect = fitz.Rect(x, y, x + width, y + height)
        if rect.x0 < 0 or rect.y0 < 0 or rect.x1 > page.rect.width + 0.01 or rect.y1 > page.rect.height + 0.01:
            raise ValueError("Печать выходит за границы страницы.")
        # Map DISPLAY coordinates to unrotated page coordinates and counter the
        # page's clockwise rotation with insert_image's anticlockwise rotation.
        # Keeping /Rotate and /CropBox avoids remove_rotation's crop expansion.
        rotation = page.rotation
        native_rect = rect * page.derotation_matrix
        # PyMuPDF's transformation_matrix omits crop offsets while /Rotate is
        # nonzero. Temporarily clear it for insertion, then restore verbatim.
        page.set_rotation(0)
        page.insert_image(native_rect, stream=image_bytes, keep_proportion=True,
                          rotate=rotation, overlay=True)
        page.set_rotation(rotation)
        metadata = dict(doc.metadata)
        metadata["keywords"] = "; ".join(filter(None, [metadata.get("keywords"), MARKER]))
        doc.set_metadata(metadata)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        doc.save(output_path, garbage=3, deflate=True)
    return {"page": page_index, "x": x, "y": y, "width": width, "height": height,
            "stamp_sha256": hashlib.sha256(image_bytes).hexdigest(),
            "source_sha256": hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest(),
            "output_sha256": hashlib.sha256(Path(output_path).read_bytes()).hexdigest()}


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def compose_pdf(pdf_path: str | Path, output_path: str | Path, overlays: list[dict]) -> dict:
    """Place existing stamp/signature PNG bytes onto a single original PDF.

    Placements use displayed-page points, including its CropBox and rotation.
    Nothing is flattened: native text, page boxes and other content remain.
    """
    if not isinstance(overlays, list) or not 1 <= len(overlays) <= 2:
        raise ValueError("Добавьте печать, подпись или оба изображения (не более двух).")
    source_path, result_path = Path(pdf_path), Path(output_path)
    if source_path.resolve() == result_path.resolve():
        raise ValueError("Сохраните результат отдельно, чтобы сохранить исходный PDF.")
    if result_path.exists():
        raise ValueError("Файл результата уже существует. Выберите другое имя.")
    prepared, kinds = [], set()
    for overlay in overlays:
        if not isinstance(overlay, dict) or overlay.get('kind') not in ('stamp', 'signature'):
            raise ValueError("Выберите изображение печати или подписи.")
        kind = overlay['kind']
        if kind in kinds:
            raise ValueError("Можно добавить одну печать и одну подпись.")
        kinds.add(kind)
        placement = overlay.get('placement')
        try:
            if not isinstance(placement, dict):
                raise ValueError
            page_index = placement['page']
            if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
                raise ValueError
            raw = [placement[key] for key in ('x', 'y', 'width', 'height')]
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in raw):
                raise ValueError
            x, y, width, height = map(float, raw)
            if not all(math.isfinite(value) for value in (x, y, width, height)) or min(width, height) <= 0:
                raise ValueError
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Некорректные координаты печати или подписи.") from exc
        try:
            image_bytes = Path(overlay['image_path']).read_bytes()
            # Use the same immutable byte snapshot for validation, insertion
            # and provenance; a second path read could refer to other pixels.
            with Image.open(io.BytesIO(image_bytes)) as image:
                side_limit = 4096 if kind == 'stamp' else 8192
                if (image.format != 'PNG' or min(image.size) < 16 or max(image.size) > side_limit
                        or image.width * image.height > 16_000_000
                        or (kind == 'signature' and getattr(image, 'n_frames', 1) != 1)):
                    raise ValueError("Нужен неподвижный PNG допустимого размера (до 16 мегапикселей).")
                aspect = image.height / image.width
                low, high = (.5, 2) if kind == 'stamp' else (.025, 4)
                if not low <= aspect <= high:
                    raise ValueError("Недопустимые пропорции изображения печати или подписи.")
                if abs((height / width) / aspect - 1) > .01:
                    raise ValueError("Пропорции изображения изменены. Установите размер без растяжения.")
                image.load()
        except (KeyError, TypeError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError("Не удалось открыть PNG печати или подписи.") from exc
        prepared.append({'kind': kind, 'placement': {'page': page_index, 'x': x, 'y': y,
                                                    'width': width, 'height': height},
                         'image_sha256': hashlib.sha256(image_bytes).hexdigest(), 'bytes': image_bytes})
    temporary_path = None
    output_created = False
    try:
        source_sha256 = _file_sha256(source_path)
        with _open_document(source_path) as doc:
            for overlay in prepared:
                placement = overlay['placement']
                if placement['page'] >= len(doc):
                    raise ValueError("Страница PDF не найдена.")
                page = doc[placement['page']]
                x, y, width, height = (placement[key] for key in ('x', 'y', 'width', 'height'))
                rect = fitz.Rect(x, y, x + width, y + height)
                if (rect.x0 < 0 or rect.y0 < 0 or rect.x1 > page.rect.width + .01
                        or rect.y1 > page.rect.height + .01):
                    raise ValueError("Печать или подпись выходит за границы страницы.")
                rotation = page.rotation
                native_rect = rect * page.derotation_matrix
                page.set_rotation(0)
                try:
                    page.insert_image(native_rect, stream=overlay['bytes'], keep_proportion=True,
                                      rotate=rotation, overlay=True)
                finally:
                    page.set_rotation(rotation)
            metadata = dict(doc.metadata)
            metadata['keywords'] = '; '.join(filter(None, [metadata.get('keywords'), MARKER]))
            doc.set_metadata(metadata)
            result_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(prefix='.stamp-composition-', suffix='.pdf', dir=result_path.parent)
            os.close(descriptor)
            temporary_path = Path(name)
            doc.save(temporary_path, garbage=3, deflate=True)
            with result_path.open('xb') as output:
                output_created = True
                with temporary_path.open('rb') as finished:
                    shutil.copyfileobj(finished, output)
                output.flush()
                os.fsync(output.fileno())
            return {'pages': len(doc), 'page_dimensions': [{'width': page.rect.width, 'height': page.rect.height} for page in doc],
                    'source_sha256': source_sha256, 'output_sha256': _file_sha256(result_path),
                    'overlays': [{key: overlay[key] for key in ('kind', 'placement', 'image_sha256')}
                                 for overlay in prepared]}
    except FileExistsError as exc:
        if output_created:
            result_path.unlink(missing_ok=True)
        raise ValueError("Файл результата уже существует. Выберите другое имя.") from exc
    except Exception:
        if output_created:
            result_path.unlink(missing_ok=True)
        raise
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _simulated_scan(image: Image.Image, profile: str, dpi: int, rng: random.Random) -> Image.Image:
    """Subtle scanner appearance; every original pixel stays inside the page.

    The expanded rotation is fitted onto a canvas of the original raster size.
    Simply rotating in place would crop text or stamps that touch a page edge.
    """
    settings = SCAN_PROFILES[profile]
    size = image.size
    tone = settings["tone"]
    # Paper colour multiplies ink too, keeping dark text and blue/red stamps.
    toned = ImageChops.multiply(image, Image.new("RGB", size, tone))
    lighting = Image.new("L", (64, 64))
    level = settings["light"]
    lighting.putdata([
        max(0, min(255, round(255 - level * (0.35 * x / 63 + 0.65 * ((y - 31.5) / 31.5) ** 2)
                                - rng.uniform(0, level * 0.25))))
        for y in range(64) for x in range(64)
    ])
    shading = lighting.resize(size, Image.Resampling.BICUBIC).convert("RGB")
    lit = ImageChops.multiply(toned, shading)
    toned.close()
    shading.close()
    lighting.close()
    blurred = lit.filter(ImageFilter.GaussianBlur(settings["blur"] * dpi / 150))
    lit.close()
    # randbytes gives a reproducible full-resolution monochrome noise field
    # without an optional NumPy dependency or millions of Python-level calls.
    noise = Image.frombytes("L", size, rng.randbytes(size[0] * size[1])).convert("RGB")
    noisy = Image.blend(blurred, noise, settings["noise"])
    blurred.close()
    noise.close()
    # A random sign/angle avoids identically tilted pages in a long document.
    magnitude = settings["skew"] * rng.uniform(0.65, 1)
    angle = magnitude if rng.random() > 0.5 else -magnitude
    rotated = noisy.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=tone)
    noisy.close()
    scale = min(size[0] / rotated.width, size[1] / rotated.height)
    fitted = rotated.resize((max(1, int(rotated.width * scale)), max(1, int(rotated.height * scale))),
                            Image.Resampling.LANCZOS)
    rotated.close()
    canvas = Image.new("RGB", size, tone)
    canvas.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    fitted.close()
    return canvas


def scan_pdf(pdf_path: str | Path, output_path: str | Path, profile: str = "standard",
             dpi: int = 150, seed: int | None = None) -> dict:
    """Export every displayed page as a colour image-only simulated scan PDF.

    Input is normally the freshly stamped PDF. Its marker is accepted, while
    password protection, signatures, parser limits and pixel budgets still
    apply. Rotation/crop is baked into the raster; displayed page sizes remain
    identical in PDF points. The original and any existing output are preserved.
    """
    if not isinstance(profile, str) or profile not in SCAN_PROFILES:
        raise ValueError("Неизвестный эффект сканирования: выберите light, standard или strong.")
    if isinstance(dpi, bool) or not isinstance(dpi, int) or dpi not in (150, 200):
        raise ValueError("Разрешение сканирования должно быть 150 или 200 dpi.")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise ValueError("Некорректное значение генератора эффекта сканирования.")
    source_path, result_path = Path(pdf_path), Path(output_path)
    if source_path.resolve() == result_path.resolve():
        raise ValueError("Результат нужно сохранить отдельным файлом, чтобы сохранить оригинал.")
    if result_path.exists():
        raise ValueError("Файл результата уже существует. Выберите другое имя.")
    temporary_path = None
    output_created = False
    try:
        with _open_document(source_path, read_only=True) as source, fitz.open() as result:
            _reject_signed_document(source)
            scale = dpi / 72
            # Preflight ALL pages before allocating the first large raster.
            pixels = [math.ceil(page.rect.width * scale) * math.ceil(page.rect.height * scale)
                      for page in source]
            if max(pixels) > SCAN_MAX_PAGE_PIXELS or sum(pixels) > SCAN_MAX_TOTAL_PIXELS:
                raise ValueError("Документ слишком большой для эффекта сканирования. Уменьшите размер страниц или число страниц.")
            rng = random.Random(seed)
            for page in source:
                pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                if pix.width * pix.height > SCAN_MAX_PAGE_PIXELS:
                    raise ValueError("Страница слишком большая для эффекта сканирования.")
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                del pix
                scanned = _simulated_scan(image, profile, dpi, rng)
                image.close()
                with io.BytesIO() as encoded:
                    scanned.save(encoded, format="JPEG", quality=SCAN_PROFILES[profile]["quality"], subsampling=0)
                    scanned.close()
                    # rect reflects both CropBox and /Rotate; copy that display
                    # size instead of the underlying MediaBox.
                    output_page = result.new_page(width=page.rect.width, height=page.rect.height)
                    output_page.insert_image(output_page.rect, stream=encoded.getvalue())
            metadata = dict(source.metadata)
            metadata["keywords"] = "; ".join(dict.fromkeys(filter(None, [metadata.get("keywords"), MARKER, SCAN_MARKER])))
            metadata["producer"] = "stamp-service / simulated print-and-scan"
            metadata["subject"] = f"Simulated scan; profile={profile}; dpi={dpi}; pages={len(source)}"
            result.set_metadata(metadata)
            result_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, name = tempfile.mkstemp(prefix=".simulated-scan-", suffix=".pdf", dir=result_path.parent)
            os.close(descriptor)
            temporary_path = Path(name)
            result.save(temporary_path, garbage=3, deflate=True)
            # Exclusive creation also protects against an output-name race.
            with result_path.open("xb") as output:
                output_created = True
                with temporary_path.open("rb") as finished:
                    shutil.copyfileobj(finished, output)
                output.flush()
                os.fsync(output.fileno())
            info = {"profile": profile, "dpi": dpi, "pages": len(source), "simulated_scan": True,
                    "source_sha256": _file_sha256(source_path), "output_sha256": _file_sha256(result_path)}
        return info
    except FileExistsError as exc:
        if output_created:
            result_path.unlink(missing_ok=True)
        raise ValueError("Файл результата уже существует. Выберите другое имя.") from exc
    except Exception:
        if output_created:
            result_path.unlink(missing_ok=True)
        raise
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
