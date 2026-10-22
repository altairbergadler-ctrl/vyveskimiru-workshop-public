"""Validated independent letter objects and deterministic PNG composition.

Text is rasterized by the editor using its measured font, never by this server.
Uploaded logos retain their original PNG bytes. Only perspective resampling and
explicitly approximate construction/light effects are applied to each object.
"""
from __future__ import annotations

import hashlib
import json
import unicodedata

import numpy as np
from PIL import Image, ImageChops, ImageFilter

import product_render as products
import facade_projection

MAX_OBJECTS = 20
MAX_OBJECT_ARTWORK_BYTES = 1024 * 1024
MAX_OBJECTS_JSON_BYTES = 4 * 1024 * 1024
METRIC_KEYS = ("width", "actualBoundingBoxAscent", "actualBoundingBoxDescent",
               "actualBoundingBoxLeft", "actualBoundingBoxRight")
OBJECT_COMPOSITION_MODE = "independent_objects_v1"
INDEPENDENT_SIGNS_MODE = "independent_signs_v1"
# Python 3.12 ships Unicode 15; the deployed Node/browser engine uses Unicode 17.
# These 106 Unicode 16/17 case additions keep classification compatible with that
# runtime. They describe Unicode categories/scripts, never glyph measurements.
UNICODE_CASE_COMPAT_POINTS = {
    "Lu": frozenset((0x1C89, 0xA7CB, 0xA7CC, 0xA7CE, 0xA7D2, 0xA7D4, 0xA7DA, 0xA7DC)),
    "Ll": frozenset((0x1C8A, 0xA7CD, 0xA7CF, 0xA7DB)),
}
UNICODE_CASE_COMPAT_RANGES = {
    "Lu": ((0x10D50, 0x10D65), (0x16EA0, 0x16EB8)),
    "Ll": ((0x10D70, 0x10D85), (0x16EBB, 0x16ED3)),
}
UNICODE_CYRILLIC_COMPAT_POINTS = frozenset((0x1C89, 0x1C8A))


def independent_signs(params):
    """The versioned wall-plane contract; the common product frame is unused."""
    return isinstance(params, dict) and params.get("composition_mode") == INDEPENDENT_SIGNS_MODE


def _text_lines(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def _unicode_category(char):
    category = unicodedata.category(char)
    if category != "Cn":
        return category
    point = ord(char)
    for compatible_category, points in UNICODE_CASE_COMPAT_POINTS.items():
        if (point in points or any(low <= point <= high
                                  for low, high in UNICODE_CASE_COMPAT_RANGES[compatible_category])):
            return compatible_category
    return category


def _height_reference_text(obj):
    """Match the editor's reference without depending on outlying text bounds."""
    reference = obj.get("height_reference", "auto")
    categories = [_unicode_category(char) for char in obj["text"]]
    uppercase = (reference == "uppercase" or
                 (reference == "auto" and
                  (any(category in ("Lu", "Lt") for category in categories)
                   or not any(category == "Ll" for category in categories))))
    cyrillic = any(category.startswith("L") and
                   (ord(char) in UNICODE_CYRILLIC_COMPAT_POINTS or "CYRILLIC" in unicodedata.name(char, ""))
                   for char, category in zip(obj["text"], categories))
    return ("Н" if uppercase else "н") if cyrillic else ("H" if uppercase else "x")


def _decode_object_artwork(obj):
    artwork = obj.get("artwork")
    if not isinstance(artwork, dict):
        raise products.ProductError("Подготовьте точный PNG каждого объекта перед визуализацией.")
    # Limit the encoded input before the common decoder allocates its bytes.
    value = artwork.get("data_url")
    if isinstance(value, str) and len(value) > ((MAX_OBJECT_ARTWORK_BYTES + 2) // 3) * 4 + 22:
        raise products.ProductError("PNG объекта слишком большой: максимум 1 МиБ.")
    if isinstance(value, str) and value.startswith("data:image/png;base64,"):
        encoded = value[22:]
        padding = 2 if encoded.endswith("==") else 1 if encoded.endswith("=") else 0
        if len(encoded) % 4 == 0 and len(encoded) // 4 * 3 - padding > MAX_OBJECT_ARTWORK_BYTES:
            raise products.ProductError("PNG объекта слишком большой: максимум 1 МиБ.")
    image, raw = products.decode_artwork(artwork)
    if len(raw) > MAX_OBJECT_ARTWORK_BYTES:
        raise products.ProductError("PNG объекта слишком большой: максимум 1 МиБ.")
    expected_source = "uploaded" if obj["type"] == "logo" else "text"
    if artwork["source"] != expected_source:
        raise products.ProductError("Логотип требует загруженный оригинал, текст — точный PNG из редактора.")
    if image.getchannel("A").getextrema()[0] == 255:
        raise products.ProductError("PNG объекта должен иметь прозрачный фон вокруг графики.")
    return image, raw


def _validate_metrics(obj, *, required):
    metrics = obj.get("preview_line_metrics")
    if metrics is None and not required:
        return
    lines = _text_lines(obj["text"])
    family = obj["font_family"].strip()
    weight = 700 if obj["font_bold"] else 400
    if (not isinstance(metrics, dict) or type(metrics.get("font_size_px")) not in (int, float)
            or metrics["font_size_px"] != 100 or not isinstance(metrics.get("lines"), list)
            or len(metrics["lines"]) != len(lines)):
        raise products.ProductError("Метрики текста объекта устарели. Откройте проект в редакторе для повторного замера.")
    for text, row in zip(lines, metrics["lines"]):
        if (not isinstance(row, dict) or row.get("text") != text
                or row.get("font_family") != family or row.get("font_weight") != weight):
            raise products.ProductError("Метрики текста объекта не соответствуют его тексту и шрифту.")
        for key in METRIC_KEYS:
            products.number(row.get(key), -1_000_000, 1_000_000, "метрики текста объекта")
        if row["width"] < 0 or (text.strip() and
                (row["actualBoundingBoxLeft"] + row["actualBoundingBoxRight"] <= 0
                 or row["actualBoundingBoxAscent"] + row["actualBoundingBoxDescent"] <= 0)):
            raise products.ProductError("Некорректные видимые границы текста объекта.")
    if obj.get("height_basis", "bounds") == "body":
        reference = metrics.get("height_reference")
        if (not isinstance(reference, dict) or reference.get("text") != _height_reference_text(obj)
                or reference.get("font_family") != family or reference.get("font_weight") != weight):
            raise products.ProductError("Метрики опорной буквы не соответствуют режиму высоты и шрифту объекта.")
        for key in METRIC_KEYS:
            products.number(reference.get(key), -1_000_000, 1_000_000, "метрики опорной буквы")
        if (reference["width"] < 0
                or reference["actualBoundingBoxLeft"] + reference["actualBoundingBoxRight"] <= 0
                or reference["actualBoundingBoxAscent"] + reference["actualBoundingBoxDescent"] <= 0):
            raise products.ProductError("Некорректные видимые границы опорной буквы.")


def validate_objects(params, require_artwork=False):
    """Validate params.objects in place-free fashion; return the original list.

    Empty editing compositions and text without a raster are permitted until a
    render is requested. Logos always need their original transparent PNG.
    """
    if not isinstance(params, dict):
        raise products.ProductError("Неверные параметры композиции.")
    objects = params.get("objects")
    if not isinstance(objects, list) or len(objects) > MAX_OBJECTS:
        raise products.ProductError("Композиция допускает массив не больше 20 объектов.")
    if params.get("composition_mode", OBJECT_COMPOSITION_MODE) not in (OBJECT_COMPOSITION_MODE, INDEPENDENT_SIGNS_MODE):
        raise products.ProductError("Неизвестная версия независимой композиции.")
    if require_artwork and not objects:
        raise products.ProductError("Добавьте хотя бы один текст или логотип.")
    try:
        serialized_size = len(json.dumps(params, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    except (TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise products.ProductError("Параметры композиции должны быть корректным JSON.") from exc
    if serialized_size > MAX_OBJECTS_JSON_BYTES:
        raise products.ProductError("Проект композиции слишком большой: максимум 4 МиБ.")
    ids = set()
    for obj in objects:
        if not isinstance(obj, dict):
            raise products.ProductError("Проверьте настройки объекта композиции.")
        identity = obj.get("id")
        if (not isinstance(identity, str) or not identity.strip() or len(identity) > 160
                or any(ord(char) < 32 for char in identity)):
            raise products.ProductError("У каждого объекта должен быть постоянный идентификатор до 160 символов.")
        if identity in ids:
            raise products.ProductError("Идентификаторы объектов композиции должны быть уникальными.")
        ids.add(identity)
        if obj.get("type") not in ("text", "logo"):
            raise products.ProductError("Неизвестный тип объекта композиции.")
        for key in ("x_cm", "y_cm"):
            products.number(obj.get(key), -100000, 100000, "положение объекта в сантиметрах")
        products.number(obj.get("rotation_deg", 0), -360000, 360000, "поворот объекта")
        products.number(obj.get("depth_cm", 0), 0, 1000, "глубина объекта")
        products.color(obj.get("side_color", "#292f30"), "цвет бортов объекта")
        brief = obj.get("brief", "")
        if not isinstance(brief, str) or len(brief) > 4000:
            raise products.ProductError("Примечание объекта должно содержать не больше 4000 символов.")
        if obj["type"] == "logo":
            products.number(obj.get("width_cm"), .001, 100000, "ширина логотипа")
        else:
            text, family = obj.get("text"), obj.get("font_family")
            if not isinstance(text, str) or len(text) > 8000 or not text.strip():
                raise products.ProductError("Введите текст объекта до 8000 символов.")
            if not isinstance(family, str) or not family.strip() or len(family) > 4000:
                raise products.ProductError("Укажите шрифт объекта до 4000 символов.")
            if type(obj.get("font_bold")) is not bool:
                raise products.ProductError("Проверьте начертание шрифта объекта.")
            products.number(obj.get("letter_height_cm"), .001, 100000, "высота букв объекта")
            if obj.get("height_basis", "bounds") not in ("body", "bounds"):
                raise products.ProductError("Неизвестный способ измерения высоты букв объекта.")
            if obj.get("height_reference", "auto") not in ("auto", "uppercase", "lowercase"):
                raise products.ProductError("Неизвестный регистр опорной буквы объекта.")
            products.number(obj.get("line_gap_cm", 0), 0, 1000, "межстрочный зазор объекта")
            if obj.get("text_align", "left") not in ("left", "center", "right"):
                raise products.ProductError("Неизвестное выравнивание строк объекта.")
            products.color(obj.get("front_color", "#fff3dc"), "цвет текста объекта")
            _validate_metrics(obj, required=require_artwork)
        if obj["type"] == "logo" or require_artwork or obj.get("artwork") is not None:
            _decode_object_artwork(obj)
    return objects


def _layout_objects(report, objects):
    layouts = report.get("sign_layout", {}).get("objects")
    if not isinstance(layouts, list) or len(layouts) != len(objects):
        raise products.ProductError("Геометрия не соответствует объектам композиции.")
    for obj, layout in zip(objects, layouts):
        if not isinstance(layout, dict) or layout.get("id") != obj["id"] or layout.get("type") != obj["type"]:
            raise products.ProductError("Порядок и идентификаторы объектов не совпадают с расчётом.")
        polygon = layout.get("polygon_px")
        if not isinstance(polygon, list) or len(polygon) != 4:
            raise products.ProductError("Проверьте четырёхугольник проекции объекта.")
        for point in polygon:
            if not isinstance(point, list) or len(point) != 2:
                raise products.ProductError("Некорректная проекция объекта.")
            for value in point:
                products.number(value, -100000000, 100000000, "проекция объекта")
        for key in ("width_cm", "height_cm"):
            products.number(layout.get(key), .000000001, 100000000, "габарит объекта")
    return layouts


def _object_scale(layout):
    q = np.asarray(layout["polygon_px"], dtype=float)
    horizontal = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / (2 * layout["width_cm"])
    vertical = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / (2 * layout["height_cm"])
    return float(min(horizontal, vertical))


def compose_objects(base, mask, project, report):
    """Project exact per-object PNGs, in object order, into a protected photo.

    Returns (RGB result, audit). The edit mask is the final pixel guard; its
    exterior is compared against the provided (possibly retouched) base.
    """
    product = products.active_product(project)
    objects = validate_objects(product.get("params"), require_artwork=True)
    layouts = _layout_objects(report, objects)
    if base.mode != "RGB" or mask.size != base.size or mask.mode != "L":
        raise products.ProductError("Основа должна быть RGB, а маска — L того же размера.")
    layer = Image.new("RGBA", base.size)
    details = []
    night = project.get("generation", {}).get("lighting") == "night"
    for obj, layout in zip(objects, layouts):
        artwork, raw = _decode_object_artwork(obj)
        warped = products.warp(artwork, base.size, layout["polygon_px"],
                               projection=layout.get("local_to_image"),
                               local_size=(layout["width_cm"], layout["height_cm"]),
                               boundary=layout.get("boundary_px"))
        alpha = warped.getchannel("A")
        depth = obj.get("depth_cm", 0)
        offset = min(12, max(0, round(depth * _object_scale(layout))))
        if depth > 0:
            offset = max(1, offset)
            shadow = products.shift_alpha(alpha, offset + 2, offset + 2).filter(ImageFilter.GaussianBlur(1.2))
            shadow = shadow.point(lambda value: round(value * .30))
            layer = Image.alpha_composite(layer, products.solid_layer(base.size, "#000000", shadow))
            # Fixed image-space direction and capped depth are illustrative.
            # Opaque side colour is revealed only beyond the exact front alpha.
            side = products.shift_alpha(alpha, offset, offset)
            for step in range(offset - 1, 0, -1):
                side = ImageChops.lighter(side, products.shift_alpha(alpha, step, step))
            layer = Image.alpha_composite(layer, products.solid_layer(base.size, obj.get("side_color", "#292f30"), side))
        if night:
            radius = min(10., max(1., _object_scale(layout) * .8))
            halo = warped.convert("RGBa").filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")
            halo.putalpha(halo.getchannel("A").point(lambda value: min(150, round(value * .9))))
            layer = Image.alpha_composite(layer, halo)
        layer = Image.alpha_composite(layer, warped)
        details.append({"id": obj["id"], "type": obj["type"], "artwork_sha256": hashlib.sha256(raw).hexdigest(),
                        "artwork_source": obj["artwork"]["source"], "artwork_size_px": list(artwork.size),
                        "polygon_px": layout["polygon_px"], "boundary_px": layout.get("boundary_px"),
                        "facade_projection": layout.get("local_to_image") if facade_projection.is_facade(layout.get("local_to_image")) else None,
                        "depth_cm": depth,
                        "side_color": obj.get("side_color", "#292f30"), "illustrative_depth_px": offset,
                        "night_illumination_on": night})
    alpha = np.asarray(layer.getchannel("A"))
    allowed = np.asarray(mask) > 0
    clipped = int(np.count_nonzero((alpha > 0) & ~allowed))
    if clipped:
        layer.putalpha(Image.fromarray(np.where(allowed, alpha, 0).astype("uint8")))
    result = Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")
    protected = ~allowed
    before, after = np.asarray(base)[protected], np.asarray(result)[protected]
    changed = int(np.count_nonzero(np.any(before != after, axis=1)))
    if changed:
        raise products.ProductError("Проверка защиты подготовленного кадра не пройдена.")
    audit = {"canvas_size_px": list(base.size), "protected_pixels": int(protected.sum()),
             "changed_pixels_outside_edit_zone": changed,
             "protected_base_sha256": hashlib.sha256(before.tobytes()).hexdigest(),
             "protected_result_sha256": hashlib.sha256(after.tobytes()).hexdigest(),
             "source_spatial_transform": "identity", "engine": "composite",
             "provider": "deterministic_composite", "model": None, "product": products.metadata(project),
             "composition_mode": product["params"].get("composition_mode", OBJECT_COMPOSITION_MODE),
             "object_count": len(objects), "objects": details,
             "exact_artwork": True, "artwork_transform": "inverse_facade_projection_premultiplied_bilinear" if any(facade_projection.is_facade(row.get("local_to_image")) for row in layouts) else "inverse_homography_bicubic",
             "geometry_source": "independent_metric_facade_projection" if any(facade_projection.is_facade(row.get("local_to_image")) for row in layouts) else "independent_object_polygons", "effects_clipped_pixels": clipped,
             "night_sign_lighting_forced_on": night,
             "scope": "Each exact source PNG is projected into its own calibrated polygon in object order. No text or logo is regenerated. Outside edit zone output equals the prepared base pixel-for-pixel.",
             "color_accuracy": "approximate_not_colorimetrically_verified",
             "material_assumptions": ["Extrusion, shadows and night glow are approximate visual effects with capped pixel depth; this is not a calibrated optical or production model."]}
    return result, audit
