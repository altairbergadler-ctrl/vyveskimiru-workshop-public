"""Install AI surface appearance through authoritative, projected source masks.

AI pixels supply colour/texture only. They cannot supply alpha, coordinates,
scale, counters, spacing or a camera transform. The scene pass contains no new
signs, so a shifted generated copy cannot remain behind the exact installation.
"""
from __future__ import annotations

import hashlib
import math

import numpy as np
from PIL import Image, ImageChops, ImageFilter

import letter_objects as letters
import product_render as products

VERSION = 1


def project_front(artwork, size, layout, margin=2):
    """Use a local ROI, including for large original logos and curved facades."""
    polygon = layout["polygon_px"]
    boundary = layout.get("boundary_px") or polygon
    left = max(0, math.floor(min(point[0] for point in boundary)) - margin)
    top = max(0, math.floor(min(point[1] for point in boundary)) - margin)
    right = min(size[0], math.ceil(max(point[0] for point in boundary)) + margin)
    bottom = min(size[1], math.ceil(max(point[1] for point in boundary)) + margin)
    if left >= right or top >= bottom:
        raise products.ProductError("Вывеска находится за границами фотографии.")
    projected = products.warp(artwork, (right-left, bottom-top),
        [[x-left, y-top] for x, y in polygon], projection=layout.get("local_to_image"),
        local_size=(layout["width_cm"], layout["height_cm"]),
        boundary=boundary, destination_offset=(left, top))
    return projected, (left, top)


def _surface(crop):
    """Extend surface RGB into transparent gaps, without using generated alpha.

    Normalized premultiplied filtering prevents black/white background fringes.
    The result is a colour field, not regenerated glyph geometry. Only pixels
    missing in the generated reference need filling; details on its face stay.
    """
    rgba = np.asarray(crop.convert("RGBA")).astype(np.float32)
    weight = rgba[:, :, 3] / 255
    known = weight > .5
    if not known.any():
        raise products.ProductError("В нейтральном образце отсутствует лицевая часть объекта.")
    rgb = rgba[:, :, :3].copy()
    premultiplied = Image.fromarray(np.clip(rgba[:, :, :3] * weight[:, :, None], 0, 255).astype("uint8"))
    alpha = crop.getchannel("A")
    for radius in (2, 8, 32, 128):
        if known.all():
            break
        denominator = np.asarray(alpha.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255
        numerator = np.asarray(premultiplied.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
        take = (~known) & (denominator > .015)
        rgb[take] = numerator[take] / denominator[take, None]
        known |= take
    if not known.all():
        rgb[~known] = np.median(rgba[weight > .5, :3], axis=0)
    return Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype("uint8"))


def surfaces(neutral, exact_sheet, sheet):
    """Register appearance rows independently; source geometry stays untouched.

    Registration is confined to the colour field. A generated row's bounds are
    never copied into the project, projection or authoritative front masks.
    """
    visible = neutral.getchannel("A").point(lambda value: 255 if value >= 32 else 0)
    generated_box = visible.getbbox()
    source_box = exact_sheet.getchannel("A").getbbox()
    if not generated_box or not source_box:
        raise products.ProductError("Нейтральный образец изделия пуст.")
    gx, gy, gr, gb = generated_box
    sx, sy, sr, sb = source_box
    rows = sheet["rows"]
    # Map the gaps between source rows into the generated product extent. This
    # retains multiline text as one object and never mixes adjacent objects.
    cuts = [gy] + [round(gy + ((a["box_px"][3] + b["box_px"][1]) / 2 - sy)
                        * (gb-gy) / (sb-sy)) for a, b in zip(rows, rows[1:])] + [gb]
    result = []
    for index, row in enumerate(rows):
        region = (gx, max(gy, cuts[index]), gr, min(gb, cuts[index+1]))
        bounds = visible.crop(region).getbbox()
        if not bounds:
            raise products.ProductError("В нейтральном образце пропущен объект. Автоматического повтора не было.")
        box = (region[0]+bounds[0], region[1]+bounds[1], region[0]+bounds[2], region[1]+bounds[3])
        crop = neutral.crop(box)
        # Match the exact source's INK box, retaining any transparent margins in
        # the source raster. Resizing colour cannot move the authoritative alpha.
        source = exact_sheet.crop(tuple(row["box_px"]))
        ink = source.getchannel("A").getbbox()
        if not ink:
            raise products.ProductError("Исходный объект не содержит видимой графики.")
        surface = _surface(crop).resize((ink[2]-ink[0], ink[3]-ink[1]), Image.Resampling.LANCZOS)
        field = Image.new("RGB", source.size, tuple(np.asarray(surface.resize((1, 1)))[0, 0]))
        field.paste(surface, ink[:2])
        result.append((field, {"id": row["id"], "generated_appearance_box_px": list(box),
                              "source_ink_box_px": list(ink), "geometry_from_generated_pixels": False}))
    return result


def _illumination(obj, params, mode):
    material = obj.get("face_material") or params.get("face_material") or {}
    material = material if isinstance(material, dict) else {}
    setting = obj.get("lighting", params.get("lighting"))
    if isinstance(setting, dict):
        setting = setting.get("mode", setting.get("illumination"))
    if setting == "off":
        return False
    if mode == "night":
        return True
    return setting == "on" or material.get("day_lighting") == "on"


def projected_front_interiors(base, rendered, mask, project, report):
    """Conservative grain mask for a fully generated surface, without pasting art.

    Source alpha fixes the permitted front interiors, not the AI silhouette.
    Unchanged source details (including retained foreground occluders) are left
    out. This mask must not be advertised as segmentation of generated pixels.
    """
    objects = letters.validate_objects(products.active_product(project)["params"], require_artwork=True)
    layouts = letters._layout_objects(report, objects)
    surface = Image.new("L", base.size)
    for obj, layout in zip(objects, layouts):
        artwork, _ = letters._decode_object_artwork(obj)
        front, (left, top) = project_front(artwork, base.size, layout)
        artwork.close()
        # Stay one source pixel inside the reference contour at uncertain AI
        # edges. Shadows and extruded sides are not inferred from image colours.
        alpha = front.getchannel("A").filter(ImageFilter.MinFilter(3))
        box = (left, top, left+front.width, top+front.height)
        before = np.asarray(base.crop(box).convert("RGB"), dtype=np.int16)
        after = np.asarray(rendered.crop(box).convert("RGB"), dtype=np.int16)
        changed = np.max(np.abs(after-before), axis=2) > 2
        alpha = Image.fromarray(np.where(changed, np.asarray(alpha), 0).astype("uint8"))
        surface.paste(ImageChops.lighter(surface.crop(box), alpha), (left, top))
    return ImageChops.multiply(surface, mask)


def install(base, mask, project, report, neutral, exact_sheet, sheet, folder):
    """Composite exact faces last; persist the mask actually used for proof."""
    params = products.active_product(project)["params"]
    objects = letters.validate_objects(params, require_artwork=True)
    layouts = letters._layout_objects(report, objects)
    appearances = surfaces(neutral, exact_sheet, sheet)
    result = base.convert("RGBA")
    all_fronts = Image.new("L", base.size)
    all_surfaces = Image.new("L", base.size) if project.get("generation", {}).get("photo_match") else None
    details = []
    mode = project.get("generation", {}).get("lighting", "original")
    allowed = np.asarray(mask) > 0
    clipped_effects = 0
    for obj, layout, (field, appearance) in zip(objects, layouts, appearances):
        artwork, raw = letters._decode_object_artwork(obj)
        scale = letters._object_scale(layout)
        # Depth/shadows are visual interpretations, not a reconstruction of
        # unavailable camera intrinsics or an inferred manufacturing dimension.
        depth = min(80, max(0, round(obj.get("depth_cm", 0) * scale * .45)))
        lit = _illumination(obj, params, mode)
        radius = min(12., max(1., scale * .6)) if lit else 0
        margin = max(4, math.ceil(depth * 2 + radius * 4 + 6))
        front, origin = project_front(artwork, base.size, layout)
        artwork.close()
        appearance_face, appearance_origin = project_front(field.convert("RGBA"), base.size, layout)
        if appearance_origin != origin or appearance_face.size != front.size:
            raise products.ProductError("Не совпали координаты лица и текстуры изделия.")
        # Always rasterize in the SAME canonical ROI as the editor guide.
        # Changing glow/depth must not change homography floating-point rounding.
        left, top = max(0, origin[0]-margin), max(0, origin[1]-margin)
        right = min(base.width, origin[0]+front.width+margin)
        bottom = min(base.height, origin[1]+front.height+margin)
        padded = []
        for image in (front, appearance_face):
            expanded = Image.new("RGBA", (right-left, bottom-top))
            expanded.paste(image, (origin[0]-left, origin[1]-top))
            padded.append(expanded)
        front, appearance_face = padded
        origin = (left, top)
        alpha = front.getchannel("A")
        # This is the geometry lock: generated alpha is NEVER the final alpha.
        appearance_face.putalpha(alpha)
        left, top = origin
        right, bottom = left+front.width, top+front.height
        local_allowed = allowed[top:bottom, left:right]
        outside_front = int(np.count_nonzero((np.asarray(alpha) > 0) & ~local_allowed))
        # Subpixel filter tails at a polygon edge may extend a few pixels; never
        # silently clip a visible face that the editor says should fit.
        visible_clipped = int(np.count_nonzero((np.asarray(alpha) >= 128) & ~local_allowed))
        if visible_clipped:
            raise products.ProductError("Зона замены обрезает лицевую часть вывески. Расширьте зону замены.")
        face_alpha = Image.fromarray(np.where(local_allowed, np.asarray(alpha), 0).astype("uint8"))
        appearance_face.putalpha(face_alpha)
        local_surface = face_alpha
        local = result.crop((left, top, right, bottom))
        if depth:
            shadow = products.shift_alpha(alpha, depth+2, depth+2).filter(ImageFilter.GaussianBlur(max(1., depth*.3)))
            shadow = shadow.point(lambda value: round(value * .27))
            local = Image.alpha_composite(local, products.solid_layer(front.size, "#000000", shadow))
            side = Image.new("L", front.size)
            for step in range(depth, 0, -1):
                side = ImageChops.lighter(side, products.shift_alpha(alpha, step, step))
            local = Image.alpha_composite(local, products.solid_layer(front.size, obj.get("side_color", "#292f30"), side))
            if all_surfaces is not None:
                local_surface = ImageChops.lighter(local_surface, side)
        if lit:
            halo = appearance_face.convert("RGBa").filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")
            halo.putalpha(halo.getchannel("A").point(lambda value: min(110, round(value*.65))))
            local = Image.alpha_composite(local, halo)
        local = Image.alpha_composite(local, appearance_face)
        # Full face opacity/antialiasing, no inward scene feather on new letters.
        local = Image.composite(local, result.crop((left, top, right, bottom)), mask.crop((left, top, right, bottom)))
        result.paste(local, origin)
        existing = all_fronts.crop((left, top, right, bottom))
        all_fronts.paste(ImageChops.lighter(existing, face_alpha), origin)
        if all_surfaces is not None:
            local_surface = ImageChops.multiply(local_surface, mask.crop((left, top, right, bottom)))
            all_surfaces.paste(ImageChops.lighter(all_surfaces.crop((left, top, right, bottom)), local_surface), origin)
        clipped_effects += outside_front
        details.append({**appearance, "type": obj["type"], "artwork_sha256": hashlib.sha256(raw).hexdigest(),
                        "polygon_px": layout["polygon_px"], "boundary_px": layout.get("boundary_px"),
                        "width_cm": layout["width_cm"], "height_cm": layout["height_cm"],
                        "source_alpha_sha256": hashlib.sha256(alpha.tobytes()).hexdigest(),
                        "front_alpha_sha256": hashlib.sha256(face_alpha.tobytes()).hexdigest(),
                        "front_roi_px": [left, top, right, bottom], "visible_front_clipped_pixels": visible_clipped,
                        "subpixel_tail_clipped_pixels": outside_front, "illustrative_depth_px": depth,
                        "illumination_on": lit})
    rgb = result.convert("RGB")
    protected = ~allowed
    if np.any(np.asarray(rgb)[protected] != np.asarray(base)[protected]):
        raise products.ProductError("Проверка защиты фотографии при установке вывески не пройдена.")
    all_fronts.save(folder / "front-mask.png")
    if all_surfaces is not None:
        all_surfaces.save(folder / "sign-surface-mask.png")
    return rgb, {"version": VERSION, "mode": "source_alpha_with_ai_surface", "exact_front_geometry": True,
                 "geometry_authority": "source_artwork_and_saved_projection", "objects": details,
                 "front_mask_sha256": hashlib.sha256((folder / "front-mask.png").read_bytes()).hexdigest(),
                 "front_mask_size_px": list(all_fronts.size), "front_mask_bbox_px": all_fronts.getbbox(),
                 "subpixel_tail_clipped_pixels": clipped_effects,
                 "appearance_accuracy": "AI_surface_and_approximate_depth_shadows_not_a_measured_optical_model"}
