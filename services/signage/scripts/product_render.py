"""Versioned product contracts and deterministic, exact-artwork photo composition.

This module never calls an image generator or loads fonts. The artwork PNG is the
approved source; perspective and local construction effects are applied to it.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import math
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import product_catalog as catalog
import facade_projection

MAX_ARTWORK_BYTES = 2 * 1024 * 1024
MAX_PROJECT_BYTES = 4 * 1024 * 1024
MAX_ARTWORK_EDGE = 4096
MAX_ARTWORK_PIXELS = 16_000_000
DEFAULT_TEMPLATE = {"channel_letters": "letters-standard", "plaque": "plaque-hours", "neon": "neon-text-pink"}
LABELS = {"channel_letters": "Объёмные буквы", "plaque": "Табличка", "neon": "Неоновая вывеска"}


class ProductError(ValueError):
    pass


class UnsupportedProductError(ProductError):
    """Keep the saved artifacts readable without permitting editing/rendering."""
    pass


def renderer(product):
    try:
        return catalog.resolve(product)[0]
    except catalog.UnsupportedCatalogError as exc:
        raise UnsupportedProductError(str(exc)) from exc
    except catalog.CatalogError as exc:
        raise ProductError(str(exc)) from exc


def renderer_family(product):
    return renderer(product)["id"]


def product_types():
    return catalog.product_types()


def number(value, low, high, label):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not low <= value <= high):
        raise ProductError(f"Проверьте параметр «{label}»: допустимо от {low:g} до {high:g}.")
    return value


def color(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ProductError(f"Укажите {label} в формате HEX #RRGGBB.")
    return value


def decode_artwork(raw):
    if not isinstance(raw, dict) or raw.get("mime_type") != "image/png":
        raise ProductError("Точный макет изделия должен быть PNG.")
    value = raw.get("data_url")
    if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
        raise ProductError("Не удалось прочитать точный PNG-макет изделия.")
    if len(value) > ((MAX_ARTWORK_BYTES + 2) // 3) * 4 + 22:
        raise ProductError("PNG-макет слишком большой: максимум 2 МиБ.")
    for key in ("width_px", "height_px"):
        dim = raw.get(key)
        if isinstance(dim, bool) or not isinstance(dim, int) or not 1 <= dim <= MAX_ARTWORK_EDGE:
            raise ProductError("Размер PNG-макета должен быть от 1 до 4096 пикселей по каждой стороне.")
    if raw["width_px"] * raw["height_px"] > MAX_ARTWORK_PIXELS:
        raise ProductError("PNG-макет превышает 16 мегапикселей.")
    if raw.get("source") not in ("uploaded", "text"):
        raise ProductError("Укажите происхождение точного макета: uploaded или text.")
    if not isinstance(raw.get("name", ""), str) or len(raw.get("name", "")) > 240:
        raise ProductError("Имя PNG-макета слишком длинное.")
    try:
        data = base64.b64decode(value.split(",", 1)[1], validate=True)
        if len(data) > MAX_ARTWORK_BYTES:
            raise ProductError("PNG-макет слишком большой: максимум 2 МиБ.")
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                raise ProductError("Используйте обычный PNG-макет без анимации.")
            if image.size != (raw["width_px"], raw["height_px"]):
                raise ProductError("Размеры PNG-макета не совпадают с данными проекта.")
            if image.width > MAX_ARTWORK_EDGE or image.height > MAX_ARTWORK_EDGE or image.width * image.height > MAX_ARTWORK_PIXELS:
                raise ProductError("PNG-макет слишком большой.")
            image.load()
            result = image.convert("RGBA")
        if not result.getchannel("A").getbbox():
            raise ProductError("PNG-макет полностью прозрачный.")
        return result, data
    except ProductError:
        raise
    except Exception as exc:
        raise ProductError("Не удалось прочитать точный PNG-макет изделия.") from exc


def active_product(project):
    if project.get("version", 1) == 1:
        return {"id": "legacy-letters", "type": "channel_letters", "module_version": 1,
                "template_id": "letters-standard", "template_version": 1,
                "placement": project.get("placement"), "params": project.get("sign", {})}
    products = project.get("products")
    if not isinstance(products, list) or len(products) != 1:
        raise ProductError("В этой версии размещайте ровно одно изделие в проекте.")
    product = products[0]
    if not isinstance(product, dict) or project.get("active_product_id") != product.get("id"):
        raise ProductError("Активное изделие не найдено в проекте.")
    return product


def normalize_project(raw, *, require_artwork=False):
    if not isinstance(raw, dict):
        raise ProductError("Не передан проект.")
    version = raw.get("version", 1)
    if isinstance(version, bool) or version not in (1, 2):
        error = UnsupportedProductError if type(version) is int and version > 2 else ProductError
        raise error("Поддерживаются версии проекта 1 и 2.")
    result = copy.deepcopy(raw)
    if version == 1:
        if isinstance(result.get("sign"), dict) and ("objects" in result["sign"]
                or result["sign"].get("composition_mode") == "independent_signs_v1"):
            from letter_objects import validate_objects
            validate_objects(result["sign"], require_artwork=require_artwork)
        return result
    product = active_product(result)
    identity = product.get("id")
    if not isinstance(identity, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", identity):
        raise ProductError("Неверный идентификатор изделия.")
    family = renderer(product)
    kind = family["id"]
    template_version = product.get("template_version")
    if isinstance(template_version, bool) or not isinstance(template_version, int) or not 1 <= template_version <= 1_000_000:
        raise ProductError("Версия шаблона должна быть целым числом от 1 до 1000000.")
    template = product.get("template_id")
    if not isinstance(template, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}", template):
        raise ProductError("Неверный идентификатор шаблона изделия.")
    params = product.get("params")
    if not isinstance(params, dict):
        raise ProductError("Неверные параметры изделия.")
    independent_signs = kind == "channel_letters" and params.get("composition_mode") == "independent_signs_v1"
    placement = product.get("placement")
    if independent_signs:
        # Absolute coordinates belong to the calibrated wall plane. Ignore any
        # historical composition frame rather than letting it limit or move signs.
        placement = None
        product["placement"] = None
    else:
        if not isinstance(placement, dict):
            raise ProductError("Укажите размещение изделия.")
        for key in ("width_cm", "height_cm"):
            number(placement.get(key), .01, 100000, "габарит изделия")
        number(placement.get("rotation_deg", 0), -360000, 360000, "поворот изделия")
    for key in ("catalog_snapshot", "module_snapshot"):
        if key not in product:
            continue
        snapshot = product[key]
        if not isinstance(snapshot, dict):
            raise ProductError("Некорректное сохранённое описание изделия.")
        if "label" in snapshot and not isinstance(snapshot["label"], str):
            raise ProductError("Некорректная сохранённая подпись изделия.")
        if any(isinstance(value, str) and len(value) > (10000 if name == "description" else 2000) for name, value in snapshot.items()):
            raise ProductError("Сохранённое описание изделия слишком длинное.")
    snapshot = product.get("catalog_snapshot", {})
    if snapshot.get("artwork_policy") == "text_or_uploaded":
        # Earlier local catalog prototypes used this equivalent spelling.
        # Normalize only the in-memory copy; uploaded_required stays strict.
        snapshot["artwork_policy"] = "text_or_upload"
    if "artwork_policy" in snapshot and snapshot["artwork_policy"] not in ("uploaded_required", "text_or_upload"):
        raise ProductError("Неизвестное сохранённое требование к макету изделия.")
    if "requires_uploaded_artwork" in snapshot and type(snapshot["requires_uploaded_artwork"]) is not bool:
        raise ProductError("Неверное сохранённое требование к оригиналу макета.")
    # Family v1 defaults are the pinned format contract. Current templates and
    # module defaults are used only when creating a new product in the browser.
    defaults = copy.deepcopy(family["defaults"])
    defaults["text"] = ""
    if kind == "channel_letters":
        defaults["face_material"] = {"type": "custom"}
    params = {**defaults, **params}
    product["params"] = params
    independent_objects = kind == "channel_letters" and ("objects" in params or independent_signs)
    if independent_objects:
        from letter_objects import validate_objects
        validate_objects(params, require_artwork=require_artwork)
    try:
        catalog.validate_parameters(product, params)
    except catalog.CatalogError as exc:
        raise ProductError(str(exc)) from exc
    limits = (("text", 300), ("font_family", 4000), ("brief", 4000)) if kind == "channel_letters" else (("text", 3000), ("font_family", 160), ("brief", 5000))
    for key, limit in limits:
        if not isinstance(params.get(key, ""), str) or len(params.get(key, "")) > limit:
            raise ProductError("Текст, шрифт или описание изделия слишком длинные.")
    if kind != "channel_letters" and not params["font_family"].strip():
        raise ProductError("Укажите название шрифта.")
    if "font_bold" in params and not isinstance(params["font_bold"], bool):
        raise ProductError("Проверьте начертание шрифта.")
    if params.get("text_align", "center") not in ("left", "center", "right"):
        raise ProductError("Неизвестное выравнивание строк.")
    number(params.get("line_gap_cm", 0), 0, 1000, "межстрочный зазор")
    color(params.get("front_color", "#fff3dc"), "цвет макета")
    if kind == "plaque":
        color(params.get("background_color", "#ffffff"), "цвет таблички")
        if params.get("material", "pvc") not in ("pvc", "acrylic", "metal"):
            raise ProductError("Выберите материал таблички.")
        if params.get("mounting", "tape") not in ("tape", "standoffs", "screws"):
            raise ProductError("Выберите крепление таблички.")
        number(params.get("thickness_mm", 3), .1, 100, "толщина таблички")
        number(params.get("corner_radius_mm", 0), 0, min(placement["width_cm"], placement["height_cm"]) * 5, "радиус углов")
        number(params.get("margin_mm", 10), 0, min(placement["width_cm"], placement["height_cm"]) * 5 - .001, "отступ макета")
    elif kind == "neon":
        number(params.get("tubing_mm", 8), 1, 100, "толщина неона")
        number(params.get("backing_margin_mm", 20), 0, min(placement["width_cm"], placement["height_cm"]) * 5 - .001, "отступ подложки")
        if params.get("backing", "clear") not in ("clear", "black", "none"):
            raise ProductError("Выберите подложку неона.")
        if params.get("illumination", "on") not in ("on", "off"):
            raise ProductError("Выберите режим свечения неона.")
    elif kind in ("flat_print", "lightbox", "cutout"):
        number(params.get("margin_mm", 0), 0, min(placement["width_cm"], placement["height_cm"]) * 5 - .001, "отступ макета")
        if kind in ("flat_print", "cutout"):
            number(params.get("opacity", 1), 0, 1, "непрозрачность макета")
        if kind == "lightbox":
            color(params.get("background_color", "#ffffff"), "фон светового короба")
            number(params.get("depth_cm", 8), 0, 1000, "глубина светового короба")
            number(params.get("glow_mm", 8), 0, 100, "условный ореол света")
            if params.get("illumination", "on") not in ("on", "off"):
                raise ProductError("Выберите режим свечения светового короба.")
    artwork = product.get("artwork")
    snapshot = product.get("catalog_snapshot", {})
    uploaded_required = family["artwork_mode"] == "upload_only" or snapshot.get("requires_uploaded_artwork") is True or snapshot.get("artwork_policy") == "uploaded_required"
    if artwork is not None:
        image, _ = decode_artwork(artwork)
        if (family.get("requires_transparency") or kind in ("neon", "cutout")) and image.getchannel("A").getextrema()[0] == 255:
            raise ProductError("Для этого изделия нужен PNG с прозрачным фоном вокруг контура.")
        if family["artwork_mode"] == "upload_only" and artwork.get("source") != "uploaded":
            raise ProductError("Для этого изделия загрузите готовый прозрачный PNG; текстовый макет не поддерживается.")
        if require_artwork and uploaded_required and artwork.get("source") != "uploaded":
            raise ProductError("Для этого изделия загрузите готовый оригинал PNG; текстовый макет не заменяет исходную графику.")
    if kind == "channel_letters" and not independent_objects and not params.get("text", "").strip():
        raise ProductError("Введите текст объёмных букв (до 300 символов).")
    if kind != "channel_letters" and require_artwork and artwork is None:
        raise ProductError("Подготовьте точный PNG-макет изделия перед визуализацией.")
    result["placement"] = copy.deepcopy(placement)
    result["sign"] = copy.deepcopy(params)
    return result


def engine(project):
    product = active_product(project)
    family = renderer(product)
    kind, capabilities = family["id"], family["capabilities"]
    generation = project.get("generation", {})
    value = generation.get("engine", "codex" if kind == "channel_letters" else "composite")
    if value not in ("codex", "composite", "codex_composite", "codex_two_stage"):
        raise ProductError("Неизвестный способ визуализации.")
    if kind == "channel_letters" and "objects" in product.get("params", {}):
        # New requests use two generative stages; explicit archived composite
        # engines remain supported. Manufacturing input stays independent of AI.
        return "codex_two_stage" if value == "codex" else value
    allowed = ((value == "codex" and kind == "channel_letters" and capabilities.get("ai"))
               or (value == "composite" and capabilities.get("composite"))
               or (value == "codex_composite" and capabilities.get("composite") and capabilities.get("background_ai", True)))
    if not allowed:
        raise ProductError("Выбранный способ визуализации не поддерживает этот вид изделия.")
    return value


def metadata(project):
    p = active_product(project)
    family = renderer(p)
    return {"id": p["id"], "type": p["type"], "label": catalog.product_label(p),
            "renderer_family": family["id"], "renderer_version": family["version"],
            "module_version": p.get("module_version", 1),
            "template_id": p.get("template_id", DEFAULT_TEMPLATE.get(p["type"], "saved-template")),
            "template_version": p.get("template_version", 1), "has_artwork": bool(p.get("artwork")),
            "artwork_name": p.get("artwork", {}).get("name") if isinstance(p.get("artwork"), dict) else None}


def archived_metadata(project):
    """Safe display provenance for an unsupported project; no executable defaults."""
    values = project.get("products")
    product = values[0] if isinstance(values, list) and values and isinstance(values[0], dict) else {}
    label = "Сохранённое изделие"
    for snapshot in (product.get("catalog_snapshot"), product.get("module_snapshot")):
        if isinstance(snapshot, dict) and isinstance(snapshot.get("label"), str) and snapshot["label"].strip():
            label = snapshot["label"][:240]
            break
    return {key: product.get(key) for key in ("id", "type", "module_version", "renderer_family", "renderer_version", "template_id", "template_version")} | {
        "label": label, "has_artwork": isinstance(product.get("artwork"), dict),
        "artwork_name": product.get("artwork", {}).get("name") if isinstance(product.get("artwork"), dict) else None}


def pixel_scale(product, polygon):
    q = np.asarray(polygon, dtype=float)
    return float((np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / (2 * product["placement"]["width_cm"]))


def padding_px(product, polygon):
    scale = pixel_scale(product, polygon)
    kind = renderer_family(product)
    if kind in ("flat_print", "cutout"):
        return 0
    if kind == "neon" and product["params"].get("illumination", "on") == "on":
        radius = min(30., max(1., product["params"].get("tubing_mm", 8) / 10 * scale * 1.8))
        return math.ceil(radius * 3 + 2)
    if kind == "lightbox":
        shadow = min(12., max(2., product["params"].get("depth_cm", 8) * scale))
        radius = min(30., max(1., product["params"].get("glow_mm", 8) / 10 * scale * 1.8)) if product["params"].get("illumination", "on") == "on" else 0
        return math.ceil(max(shadow, radius * 3) + 5)
    thickness = product["params"].get("thickness_mm", 3) / 10 * scale if kind == "plaque" else 0
    return math.ceil(min(12, max(2, thickness)) + 5)


def padded_points(product, polygon, boundary=None):
    pad = padding_px(product, polygon)
    return [[float(x + dx), float(y + dy)] for x, y in (boundary if boundary is not None else polygon)
            for dx, dy in ((-pad, -pad), (pad, -pad), (pad, pad), (-pad, pad))]


def warp(artwork, size, polygon, *, projection=None, local_size=None, boundary=None, destination_offset=(0, 0)):
    """Inverse homography; no font substitution or text regeneration."""
    if facade_projection.is_facade(projection):
        try:
            return facade_projection.warp_rgba(artwork, size, projection, local_size,
                                               boundary=boundary, destination_offset=destination_offset)
        except facade_projection.ProjectionError as exc:
            raise ProductError(str(exc)) from exc
    points = np.asarray(polygon, dtype=float)
    source = np.array([[0, 0], [artwork.width, 0], [artwork.width, artwork.height], [0, artwork.height]], dtype=float)
    matrix, target = [], []
    for (x, y), (u, v) in zip(points, source):
        matrix.extend(([x, y, 1, 0, 0, 0, -u*x, -u*y], [0, 0, 0, x, y, 1, -v*x, -v*y]))
        target.extend((u, v))
    try:
        coefficients = np.linalg.solve(np.asarray(matrix), np.asarray(target))
    except np.linalg.LinAlgError as exc:
        raise ProductError("Не удалось спроецировать макет. Проверьте размещение.") from exc
    return artwork.transform(size, Image.Transform.PERSPECTIVE, coefficients,
                             resample=Image.Resampling.BICUBIC)


def solid_layer(size, color_value, alpha):
    layer = Image.new("RGBA", size, color_value)
    layer.putalpha(alpha)
    return layer


def shift_alpha(alpha, dx, dy):
    moved = Image.new("L", alpha.size)
    moved.paste(alpha, (dx, dy))
    return moved


def compose_product(base, mask, project, report):
    product = active_product(project)
    kind, params = renderer_family(product), product["params"]
    artwork, raw = decode_artwork(product["artwork"])
    polygon = report["placement"]["polygon_px"]
    scale = pixel_scale(product, polygon)
    # A physical-aspect canvas prevents uploaded lettering from being stretched
    # to the envelope ratio. The actual artwork is uniformly fitted inside it.
    width_cm = product["placement"]["width_cm"]
    height_cm = product["placement"]["height_cm"]
    projection = report["placement"].get("local_to_image")
    boundary = report["placement"].get("boundary_px")
    def project_artwork(image):
        return warp(image, base.size, polygon, projection=projection,
                    local_size=(width_cm, height_cm), boundary=boundary)
    local_scale = min(2048 / max(width_cm, height_cm), max(2., scale * 2))
    local_size = (max(1, round(width_cm * local_scale)), max(1, round(height_cm * local_scale)))
    layer = Image.new("RGBA", base.size)
    panel = Image.new("RGBA", local_size)
    draw = ImageDraw.Draw(panel)
    if kind in ("plaque", "lightbox"):
        radius = params.get("corner_radius_mm", 0) / 10 / product["placement"]["width_cm"] * local_size[0]
        draw.rounded_rectangle((0, 0, local_size[0]-1, local_size[1]-1), radius=radius,
                               fill=params.get("background_color", "#ffffff"))
        if kind == "plaque" and params.get("material", "pvc") == "acrylic":
            draw.rounded_rectangle((0, 0, local_size[0]-1, local_size[1]-1), radius=radius,
                                   outline=(210, 220, 230, 200), width=max(1, round(local_scale * .08)))
        elif kind == "plaque" and params.get("material", "pvc") == "metal":
            # A small fixed highlight is illustrative, not measured reflection.
            draw.line((0, 1, local_size[0], 1), fill=(235, 235, 240, 230), width=max(1, round(local_scale * .1)))
        if kind == "plaque" and params.get("mounting", "tape") in ("standoffs", "screws"):
            # Mounting caps are part of the panel, beneath the exact artwork.
            cap = max(1, local_size[0] * .5 / product["placement"]["width_cm"])
            inset = cap * 2.5
            for x, y in ((inset, inset), (local_size[0]-inset, inset),
                         (local_size[0]-inset, local_size[1]-inset), (inset, local_size[1]-inset)):
                draw.ellipse((x-cap, y-cap, x+cap, y+cap), fill="#aaaaaa", outline="#555555")
        warped_panel = project_artwork(panel)
        depth_cm = params.get("depth_cm", 8) if kind == "lightbox" else params.get("thickness_mm", 3) / 10
        offset = min(12, max(2, round(depth_cm * scale)))
        shadow = shift_alpha(warped_panel.getchannel("A"), offset, offset).filter(ImageFilter.GaussianBlur(1.2))
        shadow = shadow.point(lambda a: round(a * .30))
        layer = Image.alpha_composite(layer, solid_layer(base.size, "#000000", shadow))
        layer = Image.alpha_composite(layer, warped_panel)
    elif kind == "neon":
        backing = params.get("backing", "clear")
        if backing != "none":
            draw.rounded_rectangle((0, 0, local_size[0]-1, local_size[1]-1), radius=max(1, local_size[0] * .015),
                                   fill=(0, 0, 0, 230) if backing == "black" else (205, 220, 230, 30),
                                   outline=(180, 195, 200, 80))
            layer = Image.alpha_composite(layer, project_artwork(panel))
    elif kind not in ("flat_print", "cutout"):
        raise ProductError("Семейство изделия не поддерживает точное совмещение.")
    margin_mm = (params.get("backing_margin_mm", 20) if params.get("backing", "clear") != "none" else 0) if kind == "neon" else params.get("margin_mm", 0)
    margin_x = margin_y = margin_mm / 10 * local_scale
    inner = (local_size[0] - margin_x * 2, local_size[1] - margin_y * 2)
    fit_scale = min(inner[0] / artwork.width, inner[1] / artwork.height)
    if fit_scale <= 0:
        raise ProductError("Отступы занимают весь габарит изделия.")
    fitted_size = (max(1, round(artwork.width * fit_scale)), max(1, round(artwork.height * fit_scale)))
    fitted_art = artwork.resize(fitted_size, Image.Resampling.LANCZOS)
    local_art = Image.new("RGBA", local_size)
    local_art.paste(fitted_art, ((local_size[0]-fitted_size[0])//2, (local_size[1]-fitted_size[1])//2))
    warped_art = project_artwork(local_art)
    illuminated = kind in ("neon", "lightbox") and params.get("illumination", "on") == "on"
    if illuminated:
        glow_mm = params.get("tubing_mm", 8) if kind == "neon" else params.get("glow_mm", 8)
        radius = min(30., max(1., glow_mm / 10 * scale * 1.8))
        # Blur premultiplied source RGB and alpha together so uploaded
        # multicolour contours cast their own colours, without rectangular glow.
        # Pillow's premultiplied RGBa mode avoids several frame-sized float
        # arrays, keeping the 20 MP source limit usable on the server.
        halo_source = warped_art if kind == "neon" else warped_panel
        halo = halo_source.convert("RGBa").filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")
        halo.putalpha(halo.getchannel("A").point(lambda a: min(160, round(a * 1.6))))
        layer = Image.alpha_composite(layer, halo)
    layer = Image.alpha_composite(layer, warped_art)
    if kind in ("flat_print", "cutout") and params.get("opacity", 1) != 1:
        layer.putalpha(layer.getchannel("A").point(lambda alpha: round(alpha * params["opacity"])))
    alpha = np.asarray(layer.getchannel("A"))
    allowed = np.asarray(mask) > 0
    # The request is checked for padding before work begins; this is a final
    # pixel guard, including arbitrarily complex uploaded alpha contours.
    clipped = int(np.count_nonzero((alpha > 0) & ~allowed))
    if clipped:
        clipped_alpha = np.where(allowed, alpha, 0).astype("uint8")
        layer.putalpha(Image.fromarray(clipped_alpha))
    result = Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")
    protected = ~allowed
    before, after = np.asarray(base)[protected], np.asarray(result)[protected]
    changed = int(np.count_nonzero(np.any(before != after, axis=1)))
    if changed:
        raise ProductError("Проверка защиты исходного кадра не пройдена.")
    audit = {"canvas_size_px": list(base.size), "protected_pixels": int(protected.sum()),
             "changed_pixels_outside_edit_zone": changed,
             "protected_base_sha256": hashlib.sha256(before.tobytes()).hexdigest(),
             "protected_result_sha256": hashlib.sha256(after.tobytes()).hexdigest(),
             "source_spatial_transform": "identity", "engine": "composite",
             "provider": "deterministic_composite", "model": None, "product": metadata(project),
             "exact_artwork": True, "artwork_sha256": hashlib.sha256(raw).hexdigest(),
             "artwork_source": product["artwork"]["source"], "artwork_size_px": list(artwork.size),
             "artwork_transform": "inverse_facade_projection_premultiplied_bilinear" if facade_projection.is_facade(projection) else "inverse_homography_bicubic",
             "facade_projection": projection if facade_projection.is_facade(projection) else None,
             "neon_illumination_on": kind == "neon" and illuminated,
             "lightbox_illumination_on": kind == "lightbox" and illuminated,
             "geometry_source": "metric_facade_projection" if facade_projection.is_facade(projection) else "supplied_object_cutout" if kind == "cutout" else "planar_product_envelope",
             "night_sign_lighting_forced_on": False,
             "effects_clipped_pixels": clipped,
             "scope": "Exact source artwork is projected into the product envelope. Perspective resampling and local shadows/glow are visual effects; no text is regenerated. Outside edit zone output equals lighting base pixel-for-pixel.",
             "color_accuracy": "approximate_not_colorimetrically_verified",
             "material_assumptions": ["Material reflections, shadows and neon glow are illustrative; this is not a calibrated optical or production model."]}
    return result, audit, raw
