"""Two image edits using immutable artwork and physical input as references.

The generated product is an appearance reference, never manufacturing geometry.
No exact fronts are pasted onto the second generated image. Only the existing
protected-zone guard composites that image with the unchanged scene outside it.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
import shutil

from PIL import Image

import letter_objects
import exact_letter_installation
import product_render
import facade_guide

# Version 2 cached front-surface atlases for a flat compositor. Those references
# must never be reused as the manufactured product in the restored scene edit.
VERSION = 3
MAX_EDGE = 4096
MAX_PIXELS = 20_000_000
MAX_PNG_BYTES = 100_000_000
CHECKPOINT = "product-stage.json"


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def geometry_summary(value):
    """Keep geometry metadata in polling, while original raster bytes stay in JSON files."""
    if isinstance(value, dict):
        return {key: geometry_summary(item) for key, item in value.items() if key != "data_url"}
    if isinstance(value, list):
        return [geometry_summary(item) for item in value]
    return value


def _save(image, path):
    image.save(path, "PNG")
    return _sha(path.read_bytes())


def _height_metadata(obj):
    """Describe the saved size contract; complete ink bounds come from layout."""
    if obj["type"] != "text" or "height_basis" not in obj:
        # Historical rows are also appearance cache inputs. Merely opening an
        # unchanged old project must not invalidate its prepared first stage.
        return {}
    basis = obj.get("height_basis", "bounds")
    reference = letter_objects._height_reference_text(obj) if basis == "body" else None
    return {"height_basis": basis, "height_reference": obj.get("height_reference", "auto"),
            "height_reference_case": ("uppercase" if reference in ("Н", "H") else "lowercase") if reference else None,
            "height_reference_text": reference, "nominal_letter_height_cm": obj["letter_height_cm"],
            "body_height_cm": obj["letter_height_cm"] if basis == "body" else None}


HEIGHT_PROMPT = (
    "For height_basis=body, nominal_letter_height_cm and body_height_cm specify the height of the "
    "saved height_reference_text in the requested font and weight, not the whole word's outer bounds. "
    "Use that one font scale for all glyphs and lines. Diacritics, ascenders, descenders and rounded optical "
    "overshoots retain their natural proportions outside this reference height. Never shrink a word because "
    "it contains an accent or tail, and never stretch or normalize individual letters to the nominal height. "
    "width_cm and height_cm always describe the COMPLETE front artwork bounds including these outliers. "
    "For height_basis=bounds, nominal_letter_height_cm specifies the tallest complete ink row; body_height_cm "
    "and the resolved reference are unknown. An absent height_basis is the historical bounds contract, where "
    "letter_height_cm specifies that tallest complete ink row. Preserve the supplied artwork and relative physical scale. "
)


def physical_inputs(project, report):
    """Appearance cache contract excludes all photo, camera and placement fields."""
    product = product_render.active_product(project)
    params = product.get("params", {})
    objects = letter_objects.validate_objects(params, require_artwork=True)
    layouts = letter_objects._layout_objects(report, objects)
    rows = []
    for obj, layout in zip(objects, layouts):
        _, raw = letter_objects._decode_object_artwork(obj)
        row = {key: obj[key] for key in ("type", "text", "font_family", "font_bold", "letter_height_cm",
               "line_gap_cm", "text_align", "front_color", "side_color", "depth_cm", "brief", "face_material",
               "materials", "material", "lighting", "tracking_cm", "size_basis", "construction") if key in obj}
        row.update(_height_metadata(obj))
        row.update(width_cm=layout["width_cm"], height_cm=layout["height_cm"],
                   artwork_sha256=_sha(raw), artwork_size_px=[obj["artwork"]["width_px"], obj["artwork"]["height_px"]])
        rows.append(row)
    return {"version": VERSION, "objects": rows,
            "shared_material_input": {key: params[key] for key in ("face_material", "material", "lighting", "brief", "construction") if key in params},
            "neutral_lighting": "soft_neutral_studio_internal_illumination_off",
            "material_interpretation": "source_construction_profile_material_names_unknown_grade_thickness_optics"}


def cache_key(project, report):
    return _sha(_json(physical_inputs(project, report)).encode("utf-8"))


def product_guide(project, report):
    """Stack exact front rasters with one pixels/cm scale, without scene placement."""
    objects = letter_objects.validate_objects(product_render.active_product(project)["params"], require_artwork=True)
    layouts = letter_objects._layout_objects(report, objects)
    widest = max(row["width_cm"] for row in layouts)
    tallest = max(row["height_cm"] for row in layouts)
    gap = max(tallest * .4, widest * .02)
    margin = max(tallest * .25, widest * .025)
    width_cm = widest + 2 * margin
    height_cm = sum(row["height_cm"] for row in layouts) + gap * (len(layouts) - 1) + 2 * margin
    scale = min(1600 / max(width_cm, height_cm), MAX_EDGE / max(width_cm, height_cm))
    # Maintain readable references whenever a larger bounded sheet can do so.
    smallest = min(min(row["width_cm"], row["height_cm"]) for row in layouts)
    if smallest * scale < 8:
        scale = min(8 / smallest, MAX_EDGE / max(width_cm, height_cm))
    if smallest * scale < 2:
        raise product_render.ProductError("Габариты объектов слишком различаются для общего точного референса. Разделите визуализацию на несколько проектов.")
    w, h = max(1, math.ceil(width_cm * scale)), max(1, math.ceil(height_cm * scale))
    # Generator-compatible transparent padding; never stretch the front shapes.
    w, h = math.ceil(w / 16) * 16, math.ceil(h / 16) * 16
    if w > h * 3:
        h = math.ceil(w / 3 / 16) * 16
    if h > w * 3:
        w = math.ceil(h / 3 / 16) * 16
    if w * h < 655_360:
        w = max(w, math.ceil(math.sqrt(655_360 * w / h) / 16) * 16)
        h = max(h, math.ceil(655_360 / w / 16) * 16)
    if max(w, h) > MAX_EDGE or w * h > MAX_PIXELS:
        raise product_render.ProductError("Общий референс превышает допустимый размер холста.")
    guide = Image.new("RGBA", (w, h))
    y = margin
    rows = []
    reference_images = []
    for obj, layout in zip(objects, layouts):
        art, raw = letter_objects._decode_object_artwork(obj)
        size = (max(1, round(layout["width_cm"] * scale)), max(1, round(layout["height_cm"] * scale)))
        xy = (round(margin * scale), round(y * scale))
        guide.alpha_composite(art.resize(size, Image.Resampling.LANCZOS), xy)
        # The uploaded source remains unchanged in project.json. Only the AI
        # viewing reference is bounded, just like the common product sheet;
        # otherwise a large logo hits the bridge/photo decoder's pixel guard.
        reference_size = art.size
        reference_bytes = raw
        if max(art.size) > MAX_EDGE:
            ratio = MAX_EDGE / max(art.size)
            reference_size = tuple(max(1, round(edge * ratio)) for edge in art.size)
            with art.resize(reference_size, Image.Resampling.LANCZOS) as reference:
                buffer = io.BytesIO()
                reference.save(buffer, "PNG")
                reference_bytes = buffer.getvalue()
        rows.append({"id": obj["id"], "type": obj["type"], "width_cm": layout["width_cm"],
                     "height_cm": layout["height_cm"], "box_px": [*xy, xy[0] + size[0], xy[1] + size[1]],
                     "artwork_sha256": _sha(raw), "artwork_size_px": list(art.size),
                     "generation_reference_size_px": list(reference_size),
                     "generation_reference_resampled": reference_size != art.size})
        reference_images.append(reference_bytes)
        art.close()
        y += layout["height_cm"] + gap
    return guide, {"pixels_per_cm": scale, "canvas_size_px": [w, h], "rows": rows,
                   "artwork_transform": "uniform_physical_scale_raster_reference", "geometry_authority": "project_and_exact_source_artwork"}, reference_images


def layout_guide(base, project, report):
    """The editor overlay is a reference only and has no synthetic light effects."""
    objects = letter_objects.validate_objects(product_render.active_product(project)["params"], require_artwork=True)
    layouts = letter_objects._layout_objects(report, objects)
    guide = base.convert("RGBA")
    for obj, layout in zip(objects, layouts):
        art, _ = letter_objects._decode_object_artwork(obj)
        polygon = layout["polygon_px"]
        boundary = layout.get("boundary_px") or polygon
        left = max(0, math.floor(min(point[0] for point in boundary)) - 2)
        top = max(0, math.floor(min(point[1] for point in boundary)) - 2)
        right = min(base.width, math.ceil(max(point[0] for point in boundary)) + 2)
        bottom = min(base.height, math.ceil(max(point[1] for point in boundary)) + 2)
        if left >= right or top >= bottom:
            continue
        local_polygon = [[x - left, y - top] for x, y in polygon]
        projected = product_render.warp(art, (right - left, bottom - top), local_polygon,
                                        projection=layout.get("local_to_image"),
                                        local_size=(layout["width_cm"], layout["height_cm"]),
                                        boundary=boundary, destination_offset=(left, top))
        guide.alpha_composite(projected, (left, top))
    return guide.convert("RGB")


def _safe_file(folder, name, maximum):
    candidate = folder / name
    if candidate.is_symlink() or not candidate.is_file():
        raise ValueError("Unsafe cache artifact")
    resolved = candidate.resolve(strict=True)
    if resolved.parent != folder.resolve(strict=True) or not 0 < resolved.stat().st_size <= maximum:
        raise ValueError("Invalid cache artifact")
    return resolved


def find_cached(output, current_folder, key, guide_sha):
    """Reuse only hash-verified finished first stages, including stage-2 failures."""
    output = Path(output).resolve()
    current_folder = Path(current_folder).resolve()
    for folder in sorted(output.iterdir(), key=lambda path: path.name):
        if folder == current_folder or folder.is_symlink() or not folder.is_dir():
            continue
        try:
            if folder.resolve(strict=True).parent != output:
                continue
            meta_file = _safe_file(folder, CHECKPOINT, 1024 * 1024)
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            if (not isinstance(meta, dict) or meta.get("version") != VERSION or meta.get("status") != "complete"
                    or meta.get("cache_key") != key or meta.get("product_guide_sha256") != guide_sha):
                continue
            source = _safe_file(folder, "project.json", product_render.MAX_PROJECT_BYTES).read_bytes()
            if _sha(source) != meta.get("source_project_sha256"):
                continue
            physical = meta.get("physical_input")
            if not isinstance(physical, dict) or _sha(_json(physical).encode("utf-8")) != key:
                continue
            saved_project = product_render.normalize_project(json.loads(source), require_artwork=True)
            saved_objects = product_render.active_product(saved_project)["params"]["objects"]
            if len(saved_objects) != len(physical["objects"]):
                continue
            source_report = {"sign_layout": {"objects": [{"id": obj["id"], "type": obj["type"],
                "width_cm": row["width_cm"], "height_cm": row["height_cm"],
                "polygon_px": [[0, 0], [1, 0], [1, 1], [0, 1]]}
                for obj, row in zip(saved_objects, physical["objects"])]}}
            if physical_inputs(saved_project, source_report) != physical:
                continue
            cached_guide = _safe_file(folder, "product-guide.png", MAX_PNG_BYTES)
            if _sha(cached_guide.read_bytes()) != guide_sha:
                continue
            png = _safe_file(folder, "product-neutral.png", MAX_PNG_BYTES)
            raw = png.read_bytes()
            if meta.get("product_neutral_sha256") != _sha(raw):
                continue
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG" or image.width * image.height > MAX_PIXELS:
                    continue
                image.load()
                if list(image.size) != meta.get("product_neutral_size_px"):
                    continue
                alpha = image.convert("RGBA").getchannel("A")
                if alpha.getextrema()[0] == 255 or not alpha.getbbox():
                    continue
            return raw, meta, folder.name
        except (OSError, ValueError, TypeError, KeyError, AttributeError, Image.DecompressionBombError):
            continue
    return None


def _stage1_prompt(inputs):
    return ("Use case: product-mockup / sketch-to-render. STAGE 1 of a two-stage signage visualization. "
            "Create ONE neutral photorealistic product reference sheet on a genuinely transparent background. "
            "Reference 1 is the authoritative exact front artwork sheet, with ONE common physical scale. "
            "Additional references, if supplied, are the source alpha silhouettes in sheet-row order, "
            "uniformly downsampled only when needed for viewing. Original pixel sizes and hashes below "
            "describe the preserved source artwork, not these viewing copies. "
            "Preserve every glyph shape, counters, spelling, diacritics, spacing and aspect ratio. Never redesign, "
            "retype, substitute fonts, add words, dimension labels, walls, floors, mounting panels or background rectangles. "
            "Keep the sheet's row order, row positions and relative size. " + HEIGHT_PROMPT +
            "Render manufactured channel letters using the supplied construction profile "
            "(the approved default names acrylic faces and aluminium returns; any explicit profile overrides this default), "
            "using the supplied per-object dimensions, body depth and independent colors. Material grades, thicknesses, coating "
            "and measured optical properties that are absent remain UNKNOWN; neutral clean material appearance is a "
            "visual interpretation only, never an invented manufacturing specification. Structured supplied material settings take precedence "
            "over contradictory free descriptions. The brief can describe a thin INSIDE front-edge film trim; it must not change "
            "the outer silhouette or become thick extra extrusion. When white acrylic is requested, it should look clean white, not gray, chrome or glass. "
            "Internal illumination is OFF. Use even soft neutral studio lighting, a frontal near-orthographic view, minimal visible "
            "depth, no perspective distortion, no deep shadows baked into the letters, no ground shadows, environmental reflection, "
            "bloom or halo. Keep transparent spaces around the letters and in counters. Output only the product sheet with alpha. "
            "All following dimensions and artwork hashes come from the immutable editor input, not from image estimation:\n" + _json(inputs))


def _stage2_prompt(project, report, mode, quad, work_size, scale, physical):
    objects = letter_objects.validate_objects(product_render.active_product(project)["params"], require_artwork=True)
    layouts = letter_objects._layout_objects(report, objects)
    placement = [{"id": obj["id"], "text": obj.get("text"), "polygon_px": [[x * scale, y * scale] for x, y in row["polygon_px"]],
                  "boundary_px": [[x * scale, y * scale] for x, y in (row.get("boundary_px") or row["polygon_px"])],
                  "width_cm": row["width_cm"], "height_cm": row["height_cm"]} for obj, row in zip(objects, layouts)]
    camera = facade_guide.geometry_cues(report, scale)
    return ("Use case: compositing / precise-object-edit. STAGE 2 of a TWO-generation signage visualization. "
            "Produce one believable ordinary photograph of these manufactured signs installed onto the original building. "
            "Reference 1 is the PHOTO EDIT TARGET with the NEW sign fronts ALREADY placed at their final pixel scale, "
            "positions and perspective. Edit these fronts IN PLACE into manufactured objects; their current footprints "
            "are mandatory, not suggestions. Reference 2 is the original lit photograph WITHOUT the new fronts, used "
            "to identify obsolete signs to remove, recover wall texture and preserve foreground occlusion. "
            "Reference 3 is the neutral product sheet from stage 1, used ONLY "
            "for appearance and construction. Reference 4 is the authoritative exact front artwork sheet. The product sheet's "
            "row arrangement is NOT the facade arrangement. Preserve reference 1 footprints, Cyrillic/other spelling, glyph "
            "silhouettes, counters, diacritics, spacing and aspect ratios. Never substitute a font, widen text, round off glyphs, "
            "lose letters, add words or enlarge signs for legibility. Never center a sign within the wall or editable zone, "
            "move it to the position of old signage, shrink it for margins, or reinterpret its placement aesthetically. "
            "The editable polygon permits background repair; it is NOT the sign's size or position. " + HEIGHT_PROMPT +
            "Convert the already placed fronts into real installed objects, no flat "
            "overlay stickers. Discard stage 1 studio lighting: infer actual light direction, softness, exposure, highlights "
            "and reflections from the photographed scene; match the selected scene lighting. Render the face and returns "
            "using the supplied construction and independent colors. Use the explicit lighting "
            "setting and material input; explicit construction overrides the approved acrylic/aluminium default. "
            "Render white faces clean white only when white is the requested color; preserve other requested face colors. "
            "Daytime internal LEDs are OFF unless explicitly supplied ON, night LEDs ON through "
            "the acrylic faces unless explicit input requests halo. Do not make aluminium returns glow. Add contact occlusion "
            "and cast shadows consistent with the photographed light and physical depth, preserving the underlying wall texture. "
            "Determine visible sidewalls from the actual camera and wall plane; do not simulate volume with a uniform "
            "diagonal outline offset or a generic drop shadow. Preserve the original depth order from reference 2: "
            "foreground tree branches, leaves, cables and other objects stay in their original positions IN FRONT of "
            "the installed signs wherever they cross them. Reconstruct these same occluders over the new fronts if "
            "the placement reference covers them; never erase them or paint letters over them. "
            "No giant extrusions, chromed faces, artificial bloom, cinematic grading or invented sun when the scene is overcast. "
            "Preserve the camera, framing, perspective, field of view, architecture, windows, doors, brick patterns, equipment "
            "and ground. Remove obsolete signage and mounting marks only inside the editable zone, restoring the same wall. "
            "Change only the new signs and their necessary adjacent shadows/reflections inside that zone. No unrelated cleanup, "
            "repainting, moving the camera, crop, stretch or rotation. Output the full reference-1 canvas as a photo, without "
            "collage, guide graphics, labels, divider, measurements or border. There will be NO flat front-artwork overlay "
            "after this generation. This visualization is not manufacturing geometry or measured optical simulation.\n" +
            (facade_guide.prompt_instruction(5) + "\n" if camera else "") +
            _json({"lighting": mode, "photo_rectangle_px": [0, 0, *work_size], "placement": placement,
                   "editable_polygon_px": [[float(x) * scale, float(y) * scale] for x, y in quad], "physical_input": physical,
                   **({"facade_geometry": camera} if camera else {})}))


def run(folder, output, base, mask, project, report, mode, quad, renderer, model_inputs, normalize_generated, compose, progress):
    folder, output = Path(folder), Path(output)
    exact, sheet_audit, references = product_guide(project, report)
    guide_sha = _save(exact, folder / "product-guide.png")
    inputs = physical_inputs(project, report)
    inputs["sheet_rows"] = sheet_audit["rows"]
    key = cache_key(project, report)
    cached = find_cached(output, folder, key, guide_sha)
    stage1 = folder / "stage-1"
    stage1.mkdir()
    prompt1 = _stage1_prompt(inputs)
    (stage1 / "prompt.txt").write_text(prompt1, encoding="utf-8")
    if cached:
        cached_png_bytes, checkpoint, source_job = cached
        (folder / "product-neutral.png").write_bytes(cached_png_bytes)
        checkpoint = {**checkpoint, "reused_from_job": source_job}
        progress("1/2 · Изделие восстановлено из проверенного сохранённого результата.")
    else:
        exact.save(stage1 / "product-guide.png")
        refs = [stage1 / "product-guide.png"]
        if len(references) <= 7:
            for index, raw in enumerate(references):
                path = stage1 / f"object-{index + 1:03}.png"
                path.write_bytes(raw)
                refs.append(path)
        progress("1/2 · Подготовка изделия при нейтральном освещении…")
        neutral = renderer(stage1, prompt1, stage1 / "product-guide.png", stage1 / "product-guide.png",
                           on_progress=lambda message: progress("1/2 · Подготовка изделия: " + message),
                           reference_image_paths=refs, transparent_background=True)
        if (not isinstance(neutral, Image.Image) or max(neutral.size) > MAX_EDGE
                or neutral.width * neutral.height > MAX_PIXELS):
            raise product_render.ProductError("Первая генерация вернула слишком большой или некорректный референс изделия.")
        neutral = neutral.convert("RGBA")
        alpha = neutral.getchannel("A")
        if not alpha.getbbox():
            raise product_render.ProductError("Первая генерация вернула пустой прозрачный референс. Результат не принят; автоматического повтора не было.")
        if alpha.getextrema()[0] == 255:
            raise product_render.ProductError("Первая генерация не сохранила прозрачный фон. Результат не принят; автоматического повтора не было.")
        png_sha = _save(neutral, folder / "product-neutral.png")
        checkpoint = {"version": VERSION, "status": "complete", "cache_key": key,
                      "product_guide_sha256": guide_sha, "product_neutral_sha256": png_sha,
                      "product_neutral_size_px": list(neutral.size), "reused_from_job": None}
    checkpoint.update(source_project_sha256=_sha((folder / "project.json").read_bytes()),
                      physical_input=physical_inputs(project, report))
    (folder / CHECKPOINT).write_text(_json(checkpoint), encoding="utf-8")
    exact_layout = layout_guide(base, project, report)
    exact_layout.save(folder / "layout-guide.png")
    canvas, _, _, work_size, scale = model_inputs(base, mask, report, quad)
    scaled = exact_layout.resize(work_size, Image.Resampling.LANCZOS) if exact_layout.size != work_size else exact_layout
    guide = canvas.copy()
    guide.paste(scaled, (0, 0))
    stage2 = folder / "stage-2"
    stage2.mkdir()
    # The geometry must be in the image being edited, not only in a secondary
    # reference that the model can disregard while redesigning the empty wall.
    guide.save(stage2 / "render-input.png")
    canvas.save(stage2 / "scene-reference.png")
    guide.save(stage2 / "layout-guide.png")
    shutil.copyfile(folder / "product-neutral.png", stage2 / "product-neutral.png")
    shutil.copyfile(folder / "product-guide.png", stage2 / "product-guide.png")
    refs = [stage2 / name for name in ("render-input.png", "scene-reference.png", "product-neutral.png", "product-guide.png")]
    facade_reference, facade_geometry = facade_guide.reference_image(canvas, report, scale)
    if facade_reference is not None:
        facade_reference.save(folder / "facade-grid.png")
        facade_reference.save(stage2 / "facade-grid.png")
        refs.append(stage2 / "facade-grid.png")
    prompt2 = _stage2_prompt(project, report, mode, quad, work_size, scale, physical_inputs(project, report))
    (stage2 / "prompt.txt").write_text(prompt2, encoding="utf-8")
    progress("2/2 · Установка изделия на фотографию с её освещением…")
    generated = renderer(stage2, prompt2, refs[0], stage2 / "layout-guide.png",
                         on_progress=lambda message: progress("2/2 · Установка на фото: " + message),
                         reference_image_paths=refs, transparent_background=False, preserve_placed_artwork=True)
    raw_size = list(generated.size)
    generated, normalized = normalize_generated(generated, canvas.size)
    result, audit = compose(base, generated.convert("RGB"), mask, work_size, canvas.size)
    audit.update(engine="codex_two_stage", provider="codex_subscription_two_stage", model="Codex imagegen",
                 product=product_render.metadata(project), lighting=mode, geometry=geometry_summary(report), exact_artwork=False,
                 exact_front_geometry=False, geometry_requires_visual_review=True,
                 exact_artwork_reference=True, no_artwork_overlay_after_generation=True,
                 manufacturing_source="input-project.json_and_project.json_and_production-spec.json_not_generated_images",
                 product_stage=checkpoint, product_guide=sheet_audit,
                 generated_raw_size_px=raw_size, generated_uniform_resolution_normalization=normalized,
                 installation_input={"version": VERSION, "mode": "edit_already_placed_fronts",
                     "scene_aware_installation": True,
                     "edit_target_sha256": _sha(refs[0].read_bytes()),
                     "scene_reference_sha256": _sha(refs[1].read_bytes())},
                 color_accuracy="approximate_not_colorimetrically_verified",
                 material_interpretation=physical_inputs(project, report)["material_interpretation"],
                 ai_calls_this_job=1 if cached else 2)
    if project.get("generation", {}).get("photo_match"):
        surface = exact_letter_installation.projected_front_interiors(base, result, mask, project, report)
        surface.save(folder / "sign-surface-mask.png")
        audit["photo_match_mask"] = {"source": "projected_source_front_interiors",
                                    "generated_contour_segmentation": False,
                                    "retained_source_pixels_excluded": True}
    if facade_geometry:
        audit["facade_grid_reference"] = {"image": "facade-grid.png", "geometry": facade_geometry, "reference_only": True}
    for stage, name in ((stage1, "product_image_transfer"), (stage2, "installation_image_transfer")):
        transfer = stage / "image-transfer.json"
        if transfer.is_file() and not transfer.is_symlink() and transfer.stat().st_size <= 65536:
            audit[name] = json.loads(transfer.read_text(encoding="utf-8"))
    return result, audit
