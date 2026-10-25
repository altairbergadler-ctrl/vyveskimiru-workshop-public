"""Coordinate projection and exact inverse raster mapping for a curved facade.

The photograph is never transformed. Only source-artwork samples are mapped
through the serialized metric plane and centered division-lens model shared
with geometry.js. Memory is bounded by a small output strip, not photo size.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image


class ProjectionError(ValueError):
    pass


def is_facade(value):
    return isinstance(value, dict) and value.get("type") == "facade_projection_v1"


def _parameters(projection):
    if not is_facade(projection) or projection.get("direction", "forward") != "forward":
        raise ProjectionError("Неверная модель проекции фасада.")
    try:
        matrix = np.asarray(projection["matrix"], dtype=np.float64).reshape(3, 3)
        lens = projection["lens"]
        k, cx, cy, scale = (float(lens[key]) for key in ("k", "cx", "cy", "scale"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ProjectionError("Неполные параметры проекции фасада.") from exc
    if not np.isfinite(matrix).all() or not all(math.isfinite(v) for v in (k, cx, cy, scale)) or scale <= 0:
        raise ProjectionError("Некорректные параметры проекции фасада.")
    try:
        inverse = np.linalg.inv(matrix)
    except np.linalg.LinAlgError as exc:
        raise ProjectionError("Вырожденная плоскость фасада.") from exc
    if not np.isfinite(inverse).all():
        raise ProjectionError("Неустойчивая плоскость фасада.")
    if "width" in lens or "height" in lens:
        try:
            width, height = float(lens["width"]), float(lens["height"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ProjectionError("Неверные размеры модели объектива.") from exc
        if not all(math.isfinite(v) and v > 0 for v in (width, height)):
            raise ProjectionError("Неверные размеры модели объектива.")
        radius = max((x-cx)**2 + (y-cy)**2 for x in (0, width) for y in (0, height)) / scale**2
        if abs(k) * radius > .8000001:
            raise ProjectionError("Модель объектива достигает разрыва или перегиба в кадре.")
    return matrix, inverse, (k, cx, cy, scale)


def _apply_matrix(matrix, x, y):
    denominator = matrix[2, 0]*x + matrix[2, 1]*y + matrix[2, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = (matrix[0, 0]*x + matrix[0, 1]*y + matrix[0, 2]) / denominator
        v = (matrix[1, 0]*x + matrix[1, 1]*y + matrix[1, 2]) / denominator
    valid = np.isfinite(u) & np.isfinite(v) & (np.abs(denominator) > 1e-10)
    return u, v, valid


def _undistort(x, y, lens):
    k, cx, cy, scale = lens
    dx, dy = x-cx, y-cy
    radial = k*(dx*dx + dy*dy)/scale**2
    denominator = 1+radial
    with np.errstate(divide="ignore", invalid="ignore"):
        u, v = cx+dx/denominator, cy+dy/denominator
    return u, v, np.isfinite(u) & np.isfinite(v) & (denominator > 1e-8) & (1-radial > 1e-8)


def _distort(x, y, lens):
    k, cx, cy, scale = lens
    dx, dy = x-cx, y-cy
    discriminant = 1-4*k*(dx*dx+dy*dy)/scale**2
    with np.errstate(invalid="ignore", divide="ignore"):
        factor = 2/(1+np.sqrt(np.maximum(0, discriminant)))
        u, v = cx+dx*factor, cy+dy*factor
    return u, v, np.isfinite(u) & np.isfinite(v) & (discriminant > 1e-12)


def project_points(projection, points, *, inverse=False):
    matrix, backward, lens = _parameters(projection)
    try:
        p = np.asarray(points, dtype=np.float64)
    except (ValueError, TypeError) as exc:
        raise ProjectionError("Некорректные координаты фасада.") from exc
    if p.ndim != 2 or p.shape[1] != 2 or not np.isfinite(p).all():
        raise ProjectionError("Некорректные координаты фасада.")
    if inverse:
        x, y, first = _undistort(p[:, 0], p[:, 1], lens)
        x, y, second = _apply_matrix(backward, x, y)
    else:
        x, y, first = _apply_matrix(matrix, p[:, 0], p[:, 1])
        x, y, second = _distort(x, y, lens)
    if not np.all(first & second):
        raise ProjectionError("Точка достигает горизонта или перегиба проекции фасада.")
    return np.column_stack((x, y)).tolist()


def boundary_points(projection, local_size, steps=32):
    width, height = local_size
    corners = ((0, 0), (width, 0), (width, height), (0, height))
    points = []
    for index, (x, y) in enumerate(corners):
        nx, ny = corners[(index+1) % 4]
        points.extend((x+(nx-x)*i/steps, y+(ny-y)*i/steps) for i in range(steps))
    return project_points(projection, points)


def warp_rgba(artwork, size, projection, local_size, *, boundary=None, destination_offset=(0, 0)):
    """Sample artwork by the full inverse model with premultiplied bilinear RGBA.

    local_size is the physical rectangle covered by the whole source bitmap.
    destination_offset permits a cropped installation guide while retaining
    original-photo lens coordinates. Invalid extrapolated pixels are transparent.
    """
    _, inverse, lens = _parameters(projection)
    try:
        local_width, local_height = map(float, local_size)
        offset_x, offset_y = map(float, destination_offset)
    except (TypeError, ValueError) as exc:
        raise ProjectionError("Укажите физические габариты макета.") from exc
    if not all(math.isfinite(v) and v > 0 for v in (local_width, local_height)):
        raise ProjectionError("Укажите физические габариты макета.")
    if not all(math.isfinite(v) for v in (offset_x, offset_y)):
        raise ProjectionError("Неверное смещение области проекции.")
    width, height = size
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise ProjectionError("Неверные размеры холста проекции.")
    output = Image.new("RGBA", size)
    points = np.asarray(boundary if boundary is not None else boundary_points(projection, local_size), dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 3 or not np.isfinite(points).all():
        raise ProjectionError("Некорректная граница проекции макета.")
    left = max(0, math.floor(float(points[:, 0].min())-offset_x)-2)
    right = min(width, math.ceil(float(points[:, 0].max())-offset_x)+2)
    top = max(0, math.floor(float(points[:, 1].min())-offset_y)-2)
    bottom = min(height, math.ceil(float(points[:, 1].max())-offset_y)+2)
    if left >= right or top >= bottom:
        return output
    source = np.asarray(artwork if artwork.mode == "RGBA" else artwork.convert("RGBA"), dtype=np.uint8)
    source_height, source_width = source.shape[:2]
    strip_height = max(1, min(128, 262_144//max(1, right-left)))
    for start in range(top, bottom, strip_height):
        stop = min(bottom, start+strip_height)
        yy, xx = np.mgrid[start:stop, left:right].astype(np.float64)
        ux, uy, valid_lens = _undistort(xx+offset_x+.5, yy+offset_y+.5, lens)
        lx, ly, valid_matrix = _apply_matrix(inverse, ux, uy)
        valid = valid_lens & valid_matrix & (lx >= 0) & (ly >= 0) & (lx <= local_width) & (ly <= local_height)
        sx = np.where(valid, lx/local_width*source_width-.5, 0)
        sy = np.where(valid, ly/local_height*source_height-.5, 0)
        x0, y0 = np.floor(sx).astype(np.int64), np.floor(sy).astype(np.int64)
        fx, fy = sx-x0, sy-y0
        samples = np.zeros((*sx.shape, 4), dtype=np.float32)
        for dx, dy, weight in ((0, 0, (1-fx)*(1-fy)), (1, 0, fx*(1-fy)), (0, 1, (1-fx)*fy), (1, 1, fx*fy)):
            ix, iy = x0+dx, y0+dy
            allowed = valid & (ix >= 0) & (iy >= 0) & (ix < source_width) & (iy < source_height)
            rgba = source[np.clip(iy, 0, source_height-1), np.clip(ix, 0, source_width-1)].astype(np.float32)
            rgba[:, :, :3] *= rgba[:, :, 3:4]/255
            samples += rgba*(weight*allowed)[:, :, None]
        alpha = samples[:, :, 3:4]
        np.divide(samples[:, :, :3]*255, alpha, out=samples[:, :, :3], where=alpha > 0)
        samples[:, :, :3] *= (alpha > 0)
        output.paste(Image.fromarray(np.clip(np.rint(samples), 0, 255).astype(np.uint8), "RGBA"), (left, start))
    return output


def points_inside(polygon, points):
    """Inclusive even-odd test for sampled curved boundaries (also convex quads)."""
    q, p = np.asarray(polygon, dtype=float), np.asarray(points, dtype=float)
    if q.ndim != 2 or p.ndim != 2 or q.shape[1] != 2 or p.shape[1] != 2 or len(q) < 3 or not np.isfinite(q).all() or not np.isfinite(p).all():
        return False
    inside = np.zeros(len(p), dtype=bool)
    boundary = np.zeros(len(p), dtype=bool)
    x, y = p[:, 0], p[:, 1]
    for a, b in zip(q, np.roll(q, -1, axis=0)):
        dx, dy = b-a
        cross = dx*(y-a[1])-dy*(x-a[0])
        tolerance = 1e-6*max(1., math.hypot(dx, dy))
        boundary |= (np.abs(cross) <= tolerance) & (x >= min(a[0], b[0])-1e-6) & (x <= max(a[0], b[0])+1e-6) & (y >= min(a[1], b[1])-1e-6) & (y <= max(a[1], b[1])+1e-6)
        if abs(dy) > 1e-15:
            inside ^= ((a[1] > y) != (b[1] > y)) & (x < (b[0]-a[0])*(y-a[1])/dy+a[0])
    return bool(np.all(inside | boundary))
