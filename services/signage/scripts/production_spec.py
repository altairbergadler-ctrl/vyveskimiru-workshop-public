"""Immutable manufacturing inputs, independent of any generated photograph.

Raster fronts and font names are references, not certified milling contours.
Unknown physical properties remain null; no image-model output is accepted here.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math

import product_render


CONFIRMED_CONSTRUCTION = {
    "version": 1,
    "face": {"material": "acrylic", "thickness_mm": None},
    "returns": {"material": "aluminium", "thickness_mm": None, "finish": None},
    "provenance": {"face_material": "owner_confirmed", "returns_material": "owner_confirmed"},
}


def with_confirmed_construction(project):
    """Record this owner's explicit construction before AI, without changing entered data."""
    result = copy.deepcopy(project)
    params = product_render.active_product(result)["params"]
    if "construction" not in params:
        params["construction"] = copy.deepcopy(CONFIRMED_CONSTRUCTION)
    return result


def _dimension(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("Missing validated front dimension")
    return value


def build(project, report, project_bytes, input_project_bytes=None):
    if not isinstance(project_bytes, bytes) or len(project_bytes) > product_render.MAX_PROJECT_BYTES:
        raise ValueError("Invalid saved project snapshot")
    saved = json.loads(project_bytes.decode("utf-8"))
    received = None
    if input_project_bytes is not None:
        if not isinstance(input_project_bytes, bytes) or len(input_project_bytes) > product_render.MAX_PROJECT_BYTES:
            raise ValueError("Invalid received project snapshot")
        received = json.loads(input_project_bytes.decode("utf-8"))
        if not isinstance(received, dict):
            raise ValueError("Invalid received project snapshot")
    product = product_render.active_product(saved)
    params = product["params"]
    current = product_render.active_product(project)
    objects = params.get("objects")
    if not isinstance(objects, list) or objects != current["params"].get("objects"):
        raise ValueError("Saved source objects differ from validated inputs")
    layouts = {item["id"]: item for item in report["sign_layout"]["objects"]}
    if len(layouts) != len(objects) or set(layouts) != {obj["id"] for obj in objects}:
        raise ValueError("Validated layout does not match saved source objects")
    result = []
    for obj in objects:
        layout = layouts[obj["id"]]
        decoder = product_render.decode_logo_artwork if obj["type"] == "logo" else product_render.decode_artwork
        front, data = decoder(obj["artwork"])
        artwork = copy.deepcopy(obj["artwork"])
        artwork.pop("data_url", None)
        artwork.update(sha256=hashlib.sha256(data).hexdigest(),
                       pixel_size=list(front.size), source_file="project.json",
                       source_object_id=obj["id"])
        source_input = copy.deepcopy(obj)
        source_input["artwork"] = artwork
        result.append({
            "id": obj["id"], "type": obj["type"],
            "source_input": source_input,
            "front_dimensions_cm": {"width": _dimension(layout["width_cm"]),
                                     "height": _dimension(layout["height_cm"])},
            "dimension_basis": "validated_editor_geometry_from_saved_input_sizes_and_front_reference",
            "depth_cm": obj.get("depth_cm"),
            "front_color": obj.get("front_color"), "return_color": obj.get("side_color"),
            "material_input": {"object_materials": copy.deepcopy(obj.get("materials")),
                               "object_description": obj.get("brief", ""),
                               "shared_face_material": copy.deepcopy(params.get("face_material")),
                               "shared_description": params.get("brief", ""),
                               "construction": copy.deepcopy(obj.get("construction", params.get("construction")))},
            "vector_contours": None,
            "contour_status": "exact_source_raster_preserved_vector_contours_required",
        })
    shared = copy.deepcopy(params)
    shared.pop("objects", None)
    snapshot = {
        "format": "signage-production-input", "version": 1,
        "units": {"front_dimensions": "cm", "depth": "cm", "installation_coordinates": "cm",
                  "field_suffixes": {"_cm": "cm", "_mm": "mm"}},
        "source": {"project_file": "project.json", "project_sha256": hashlib.sha256(project_bytes).hexdigest(),
                   "project_version": saved.get("version"), "product_id": product["id"],
                   "authority": "saved_user_inputs_before_image_generation"},
        "product_type": product["type"], "shared_input": shared, "objects": result,
        "installation_reference": {"calibration": copy.deepcopy(saved.get("calibration")),
                                   "measurements": copy.deepcopy(saved.get("measurements", [])),
                                   "checks": copy.deepcopy(saved.get("checks", [])),
                                   "accuracy_notes": copy.deepcopy(report.get("warnings", []))},
        "manufacturing_readiness": {"ready": False,
                                   "reason": "Exact vector contours and a confirmed material/construction specification are required before manufacturing.",
                                   "unknowns_are_not_inferred_from_generated_images": True},
        "generated_images_are_manufacturing_sources": False,
    }
    if received is not None:
        snapshot["source"].update(received_input_file="input-project.json",
                                  received_input_sha256=hashlib.sha256(input_project_bytes).hexdigest(),
                                  received_input_is_preserved_separately_from_validated_defaults=True)
    # Reject NaN/unsupported values before a snapshot is written or an AI call is made.
    json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
    return snapshot
