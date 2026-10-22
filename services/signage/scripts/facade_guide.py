"""Deterministic camera/grid reference for generative signage installation.

This is a separate reference image, never an edit target or a final overlay.
Its world spacing depends only on the calibrated installation plane; editor
grid visibility, snapping preferences and UI grid spacing cannot change it.
"""
from __future__ import annotations

import copy
import math

import numpy as np
from PIL import ImageDraw

import facade_projection as projection


def _clip_segment(a, b, polygon):
    q = np.asarray(polygon, dtype=float)
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    direction = b-a
    area = np.sum(q[:, 0]*np.roll(q[:, 1], -1)-np.roll(q[:, 0], -1)*q[:, 1])
    winding = 1 if area >= 0 else -1
    enter, leave = 0., 1.
    for p, following in zip(q, np.roll(q, -1, axis=0)):
        edge, relative = following-p, a-p
        start = winding*(edge[0]*relative[1]-edge[1]*relative[0])
        slope = winding*(edge[0]*direction[1]-edge[1]*direction[0])
        if abs(slope) < 1e-12:
            if start < -1e-7:
                return None
            continue
        crossing = -start/slope
        if slope > 0:
            enter = max(enter, crossing)
        else:
            leave = min(leave, crossing)
        if enter > leave+1e-12:
            return None
    if leave < 0 or enter > 1:
        return None
    enter, leave = max(0., min(1., enter)), max(0., min(1., leave))
    if leave-enter < 1e-10:
        return None
    return a+direction*enter, a+direction*leave


def _step(span):
    raw = max(span/8, .000001)
    power = 10**math.floor(math.log10(raw))
    return next(multiplier*power for multiplier in (1, 2, 5, 10) if multiplier*power >= raw)


def geometry_cues(report, scale=1.):
    calibration = report.get("calibration", {})
    model, polygon = calibration.get("worldToImage"), calibration.get("target_world_cm")
    if not projection.is_facade(model) or polygon is None:
        return None
    if not math.isfinite(scale) or scale <= 0:
        raise projection.ProjectionError("Неверный масштаб reference сетки фасада.")
    q = np.asarray(polygon, dtype=float)
    if q.shape != (4, 2) or not np.isfinite(q).all():
        raise projection.ProjectionError("Некорректная плоскость reference сетки фасада.")
    minimum, maximum = np.min(q, axis=0), np.max(q, axis=0)
    step = _step(float(np.max(maximum-minimum)))
    lines = []
    for axis in (0, 1):
        start, stop = math.ceil(minimum[axis]/step), math.floor(maximum[axis]/step)
        for index in range(start, stop+1):
            value = index*step
            a, b = minimum.copy(), maximum.copy()
            a[axis] = b[axis] = value
            segment = _clip_segment(a, b, q)
            if segment is None:
                continue
            world = [segment[0]+(segment[1]-segment[0])*t/32 for t in range(33)]
            pixels = np.asarray(projection.project_points(model, world))*scale
            lines.append({"axis": "x" if axis == 0 else "y", "value_cm": float(value),
                          "world_endpoints_cm": [segment[0].tolist(), segment[1].tolist()],
                          "samples_px": [[round(float(x), 3), round(float(y), 3)] for x, y in pixels[::4]]})
    working_model = copy.deepcopy(model)
    working_model["matrix"] = [value*scale if i < 6 else value for i, value in enumerate(model["matrix"])]
    for key in ("cx", "cy", "scale", "width", "height"):
        if key in working_model["lens"]:
            working_model["lens"][key] *= scale
    boundary = calibration.get("target_boundary_px")
    if boundary is None:
        boundary = []
        for a, b in zip(q, np.roll(q, -1, axis=0)):
            boundary.extend(projection.project_points(model, [a+(b-a)*t/8 for t in range(8)]))
    else:
        boundary = boundary[::max(1, len(boundary)//32)]
    return {"model": working_model, "world_unit": "cm", "pixel_space": "working_generation_canvas",
            "original_to_working_scale": scale, "grid_step_cm": step,
            "target_world_cm": polygon,
            "target_boundary_samples_px": [[round(float(x)*scale, 3), round(float(y)*scale, 3)] for x, y in boundary],
            "lines": lines,
            "role": "camera_and_curvature_reference_only_not_final_graphics"}


def reference_image(canvas, report, scale=1.):
    cues = geometry_cues(report, scale)
    if cues is None:
        return None, None
    result = canvas.convert("RGB").copy()
    draw = ImageDraw.Draw(result)
    model = report["calibration"]["worldToImage"]
    for line in cues["lines"]:
        a, b = (np.asarray(point) for point in line["world_endpoints_cm"])
        pixels = projection.project_points(model, [a+(b-a)*t/32 for t in range(33)])
        draw.line([(float(x)*scale, float(y)*scale) for x, y in pixels], fill="#31b9d5", width=2)
    boundary = report["calibration"].get("target_boundary_px")
    if boundary:
        pixels = [(float(x)*scale, float(y)*scale) for x, y in boundary]
        draw.line(pixels+pixels[:1], fill="#f2b44a", width=3)
    return result, cues


def prompt_instruction(reference_number):
    return (f"Reference {reference_number} is ONLY the authoritative calibrated FACADE GRID and camera/curvature reference. "
            "Its cyan curves represent straight, equally spaced physical lines on the facade after this photograph's "
            "perspective and lens projection; amber marks the installation boundary. Use the exact placement guide for "
            "object positions and preserve the grid's local axes, scale, convergence and curvature when installing every "
            "letter and logo. A straight source-artwork baseline or edge may be curved in the photo: do not straighten, "
            "flatten, shift, rotate, stretch or independently resize it for appearance. Apply the same local camera/lens "
            "projection to the complete front shape, including contours, holes and spacing. Do not rectify, undistort or "
            "move the original photograph. NEVER copy grid lines, boundary marks or guide graphics into the result. "
            "The JSON camera/grid model and samples use working-generation-canvas pixels with the stated scale; "
            "centimetres belong to the calibrated physical plane. This is a generation reference, not a verified "
            "pixel-geometry acceptance test. ")
