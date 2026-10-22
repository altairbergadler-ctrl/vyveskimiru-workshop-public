"""Load the shared data catalog; executable renderer families stay allowlisted here."""
from __future__ import annotations

import copy
from functools import lru_cache
import json
import math
from pathlib import Path
import re

CATALOG_PATH = Path(__file__).resolve().parent.parent / "assets" / "product-catalog.json"
RENDERER_FAMILIES = frozenset({"channel_letters", "plaque", "neon", "flat_print", "lightbox", "cutout"})
FAMILY_ARTWORK_MODES = {key: "none" if key == "channel_letters" else "upload_only" if key == "cutout" else "text_or_upload" for key in RENDERER_FAMILIES}
FIELD_KINDS = frozenset({"number", "color", "select", "string", "boolean"})
ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\Z")
RESERVED_FIELDS = frozenset({"__proto__", "prototype", "constructor"})
COMMON_FIELDS = frozenset({"text", "font_family", "font_bold", "text_align", "line_gap_cm", "front_color", "brief", "face_material", "preview_line_metrics", "preview_font_status", "size_basis"})


class CatalogError(ValueError):
    pass


class UnsupportedCatalogError(CatalogError):
    """Well-formed saved identity whose executable contract is unavailable."""
    pass


def identity(value, label):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise CatalogError(f"{label}: неверный идентификатор.")
    return value


def version(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1_000_000:
        raise CatalogError(f"{label}: версия должна быть целым числом от 1 до 1000000.")
    return value


def field_schema(raw):
    if not isinstance(raw, list) or len(raw) > 100:
        raise CatalogError("Некорректная схема полей изделия.")
    found = set()
    for field in raw:
        if not isinstance(field, dict):
            raise CatalogError("Некорректное поле изделия.")
        key = identity(field.get("key"), "Поле")
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", key) or key in found or key in RESERVED_FIELDS or field.get("kind") not in FIELD_KINDS:
            raise CatalogError("Повторяющееся или неизвестное поле изделия.")
        if not isinstance(field.get("label"), str) or not field["label"].strip() or len(field["label"]) > 240:
            raise CatalogError("Некорректная подпись поля изделия.")
        found.add(key)
        for bound in ("min", "max"):
            value = field.get(bound)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise CatalogError("Некорректные границы поля изделия.")
        if field.get("min") is not None and field.get("max") is not None and field["min"] > field["max"]:
            raise CatalogError("Перепутаны границы поля изделия.")
        if field["kind"] == "number" and (field.get("min") is None or field.get("max") is None):
            raise CatalogError("Для числового поля нужны обе границы.")
        if field["kind"] == "select":
            options = field.get("options")
            if not isinstance(options, list) or not options or any(not isinstance(option, dict) or not isinstance(option.get("value"), str) or not isinstance(option.get("label"), str) or not option["label"].strip() for option in options):
                raise CatalogError("Некорректные варианты поля изделия.")
            if len({option["value"] for option in options}) != len(options):
                raise CatalogError("Повторяющиеся варианты поля изделия.")
        if field["kind"] == "string" and (type(field.get("max_length")) is not int or not 1 <= field["max_length"] <= 5000):
            raise CatalogError("Некорректная длина текстового поля.")
        if "default" in field and not valid_field_value(field, field["default"]):
            raise CatalogError("Начальное значение не соответствует полю изделия.")
    return raw


def valid_field_value(field, value):
    kind = field["kind"]
    if kind == "number":
        return type(value) in (int, float) and math.isfinite(value) and field["min"] <= value <= field["max"]
    if kind == "color":
        return isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) is not None
    if kind == "boolean":
        return type(value) is bool
    if kind == "select":
        return isinstance(value, str) and any(value == item["value"] for item in field["options"])
    return isinstance(value, str) and len(value) <= field["max_length"]


@lru_cache(maxsize=1)
def load_catalog():
    try:
        raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise CatalogError("Не удалось прочитать каталог изделий.") from exc
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int or raw["schema_version"] != 1:
        raise CatalogError("Версия каталога изделий не поддерживается.")
    version(raw.get("revision"), "Каталог")
    if any(not isinstance(raw.get(group), list) for group in ("families", "modules", "templates")):
        raise CatalogError("В каталоге нужны списки семейств, изделий и шаблонов.")
    families, modules, templates = {}, {}, {}
    for family in raw["families"]:
        if not isinstance(family, dict):
            raise CatalogError("Некорректное семейство обработки.")
        key = identity(family.get("id"), "Семейство")
        if key not in RENDERER_FAMILIES or key in families or type(family.get("version")) is not int or family["version"] != 1:
            raise CatalogError("Неизвестное семейство или версия обработки.")
        if family.get("artwork_mode") not in ("none", "text_or_upload", "upload_only") or not isinstance(family.get("defaults"), dict):
            raise CatalogError("Некорректное описание макета семейства.")
        if family["artwork_mode"] != FAMILY_ARTWORK_MODES[key] or family.get("requires_transparency", False) is not (key in ("neon", "cutout")):
            raise CatalogError("Контракт макета и прозрачности семейства версии 1 менять нельзя.")
        capabilities = family.get("capabilities")
        if not isinstance(capabilities, dict) or any(type(value) is not bool for value in capabilities.values()):
            raise CatalogError("Некорректные возможности семейства.")
        if key != "channel_letters" and (capabilities.get("ai") or capabilities.get("corel")):
            raise CatalogError("ИИ-рисование букв и Corel доступны только семейству объёмных букв.")
        if key == "channel_letters" and capabilities.get("composite"):
            raise CatalogError("Точное наложение не поддерживает семейство объёмных букв.")
        if capabilities.get("background_ai") and not capabilities.get("composite"):
            raise CatalogError("Подготовка фона требует точного наложения изделия.")
        field_schema(family.get("field_schema"))
        families[key] = family
    for module in raw.get("modules", []):
        if not isinstance(module, dict):
            raise CatalogError("Некорректный вид изделия.")
        key = identity(module.get("type"), "Изделие")
        if not isinstance(module.get("renderer_family"), str):
            raise CatalogError("Некорректное семейство вида изделия.")
        family = families.get(module["renderer_family"])
        if key in modules or family is None or type(module.get("module_version")) is not int or module["module_version"] != 1:
            raise CatalogError("Неизвестный вид или версия изделия.")
        if type(module.get("renderer_version")) is not int or module["renderer_version"] != family["version"] or not isinstance(module.get("defaults", {}), dict):
            raise CatalogError("Изделие ссылается на неизвестную версию обработки.")
        extras = field_schema(module.get("field_schema", []))
        if {item["key"] for item in extras} & ({item["key"] for item in family["field_schema"]} | COMMON_FIELDS):
            raise CatalogError("Дополнительные поля не могут заменять контракт семейства.")
        modules[key] = module
    for legacy in ("channel_letters", "plaque", "neon"):
        module = modules.get(legacy)
        if module is None or module["renderer_family"] != legacy or module["renderer_version"] != 1:
            raise CatalogError("Исторические виды изделий должны сохранять исходное семейство обработки.")
    for template in raw.get("templates", []):
        if not isinstance(template, dict):
            raise CatalogError("Некорректный шаблон изделия.")
        key = identity(template.get("id"), "Шаблон")
        if key in templates or template.get("type") not in modules:
            raise CatalogError("Шаблон ссылается на неизвестное изделие.")
        version(template.get("version"), "Шаблон")
        if not isinstance(template.get("params", {}), dict) or not isinstance(template.get("default_placement"), dict):
            raise CatalogError("Некорректные параметры шаблона.")
        if "artwork_policy" in template and template["artwork_policy"] not in ("uploaded_required", "text_or_upload"):
            raise CatalogError("Неизвестное требование к макету шаблона.")
        if "requires_uploaded_artwork" in template and type(template["requires_uploaded_artwork"]) is not bool:
            raise CatalogError("Неверное требование к оригиналу макета шаблона.")
        templates[key] = template
    if not families or not modules or not templates:
        raise CatalogError("Каталог изделий пуст.")
    return {"raw": raw, "families": families, "modules": modules, "templates": templates}


def product_types():
    return tuple(load_catalog()["modules"])


def public_catalog():
    return copy.deepcopy(load_catalog()["raw"])


def resolve(product):
    """A retired type can use a saved supported family, never saved capabilities."""
    data = load_catalog()
    kind = identity(product.get("type"), "Изделие")
    if type(product.get("module_version")) is not int or product["module_version"] != 1:
        raise UnsupportedCatalogError("Версия модуля изделия не поддерживается.")
    module = data["modules"].get(kind)
    family_id = product.get("renderer_family", module.get("renderer_family") if module else None)
    family_version = product.get("renderer_version", module.get("renderer_version") if module else None)
    if family_id is not None and not isinstance(family_id, str):
        raise CatalogError("Некорректное семейство обработки изделия.")
    family = data["families"].get(family_id)
    if family is None or type(family_version) is not int or family_version != family["version"]:
        raise UnsupportedCatalogError("Семейство или версия обработки изделия не поддерживается.")
    snapshot = product.get("module_snapshot")
    if "module_snapshot" in product:
        if not isinstance(snapshot, dict) or snapshot.get("renderer_family", family_id) != family_id or snapshot.get("renderer_version", family_version) != family_version:
            raise CatalogError("Сохранённое описание обработки не соответствует изделию.")
        if "renderer_version" in snapshot and type(snapshot["renderer_version"]) is not int:
            raise CatalogError("Неверная сохранённая версия обработки.")
        if "module_version" in snapshot and (type(snapshot["module_version"]) is not int or snapshot["module_version"] != product["module_version"]):
            raise CatalogError("Неверная сохранённая версия модуля изделия.")
    if module and (family_id != module["renderer_family"] or family_version != module["renderer_version"]):
        # Explicit old snapshots continue to use their installed family when a
        # custom catalog entry is remapped. The snapshot can select only trusted
        # code already installed on this server; it never grants capabilities.
        pinned = (isinstance(snapshot, dict) and snapshot.get("renderer_family") == family_id
                  and type(snapshot.get("renderer_version")) is int and snapshot["renderer_version"] == family_version
                  and type(snapshot.get("module_version")) is int and snapshot["module_version"] == product["module_version"])
        if not pinned:
            raise CatalogError("Семейство обработки не соответствует виду изделия.")
    return family, module


def parameter_fields(product):
    family, module = resolve(product)
    snapshot = product.get("module_snapshot")
    if isinstance(snapshot, dict) and "field_schema" in snapshot:
        extras = field_schema(snapshot["field_schema"])
    else:
        extras = module.get("field_schema", []) if module else []
    if {item["key"] for item in extras} & ({item["key"] for item in family["field_schema"]} | COMMON_FIELDS):
        raise CatalogError("Дополнительные поля не могут заменять общий контракт или контракт семейства.")
    return family["field_schema"] + extras


def validate_parameters(product, params):
    for field in parameter_fields(product):
        key, kind = field["key"], field["kind"]
        if key not in params and "default" not in field:
            continue
        value = params.get(key, field.get("default"))
        label = field.get("label", key)
        if not valid_field_value(field, value):
            raise CatalogError(f"Проверьте параметр «{label}».")


def product_label(product):
    for snapshot in (product.get("catalog_snapshot"), product.get("module_snapshot")):
        if isinstance(snapshot, dict) and isinstance(snapshot.get("label"), str) and snapshot["label"].strip():
            return snapshot["label"][:240]
    module = load_catalog()["modules"].get(product.get("type"))
    return module.get("label", product["type"]) if module else product["type"]
