"""Match source-photo grain on exact sign surfaces, without moving any pixels.

This is a bounded statistical estimate from smooth, unclipped source patches,
not a reconstruction of sensor noise. All calculations use original resolution.
"""
from __future__ import annotations

import hashlib
import numpy as np
from PIL import Image

VERSION = "source_noise_v1"


def estimate(image, surface=None):
    """Robust RGB high-frequency covariance; linear gradients cancel exactly."""
    patches = []
    width, height = image.size
    edge = min(40, width, height)
    if edge < 8:
        return np.zeros((3, 3)), 0
    for top in np.unique(np.linspace(0, height-edge, min(8, max(1, height//edge)), dtype=int)):
        for left in np.unique(np.linspace(0, width-edge, min(12, max(1, width//edge)), dtype=int)):
            box = (int(left), int(top), int(left+edge), int(top+edge))
            rgb = np.asarray(image.crop(box).convert("RGB"), dtype=np.float32)
            valid = np.all((rgb > 2) & (rgb < 253), axis=2)
            if surface is not None:
                valid &= np.asarray(surface.crop(box)) >= 248
            # Every pixel in the 3x3 stencil must be inside the surface. This
            # excludes antialiased glyph edges and background between letters.
            keep = np.logical_and.reduce([valid[y:y+edge-2, x:x+edge-2] for y in range(3) for x in range(3)])
            if np.count_nonzero(keep) < 80:
                continue
            horizontal = rgb[:, :-2] - 2*rgb[:, 1:-1] + rgb[:, 2:]
            residual = (horizontal[:-2] - 2*horizontal[1:-1] + horizontal[2:]) / 6
            values = residual[keep]
            sigma = np.median(np.abs(values-np.median(values, axis=0)), axis=0) / .67448975
            # Large-scale variation ranks surfaces, not JPEG or sensor grain.
            coarse = rgb[:edge//4*4, :edge//4*4].reshape(edge//4, 4, edge//4, 4, 3).mean(axis=(1, 3))
            roughness = float(np.mean(np.abs(np.diff(coarse, axis=0))) + np.mean(np.abs(np.diff(coarse, axis=1))))
            patches.append((roughness, sigma, values))
    if not patches:
        return np.zeros((3, 3)), 0
    selected = sorted(patches, key=lambda item: item[0])[:max(1, len(patches)//4)]
    sigma = np.clip(np.median([item[1] for item in selected], axis=0), 0, 12)
    sigma[sigma < .35] = 0
    values = np.concatenate([item[2] for item in selected])
    limit = np.maximum(sigma*3, .1)
    clipped = np.clip(values, -limit, limit)
    covariance = np.atleast_2d(np.cov(clipped, rowvar=False))
    denominator = np.sqrt(np.maximum(np.diag(covariance), 1e-10))
    correlation = covariance / np.outer(denominator, denominator)
    # Shrink a little toward independent channels to avoid unstable estimates.
    correlation = .95*correlation + .05*np.eye(3)
    return correlation*np.outer(sigma, sigma), len(selected)


def apply(source, rendered, surface):
    if source.size != rendered.size or surface.size != rendered.size or surface.mode != "L":
        raise ValueError("Photo matching requires a source-sized exact surface mask.")
    desired, samples = estimate(source)
    existing, existing_samples = estimate(rendered, surface)
    # Only add the missing variance. Never blur text to remove existing texture.
    remaining = np.maximum(np.diag(desired)-np.diag(existing), 0)
    scale = np.sqrt(remaining / np.maximum(np.diag(desired), 1e-10))
    covariance = desired*np.outer(scale, scale)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    transform = eigenvectors @ np.diag(np.sqrt(np.maximum(eigenvalues, 0)))
    seed = hashlib.sha256(source.resize((64, 64)).tobytes() + surface.tobytes()).digest()
    random = np.random.default_rng(int.from_bytes(seed[:8], "big"))
    result = rendered.convert("RGB").copy()
    bounds = surface.getbbox()
    changed = 0
    if bounds and float(np.max(remaining)) >= .12:
        left, top, right, bottom = bounds
        for y in range(top, bottom, 128):
            box = (left, y, right, min(y+128, bottom))
            before = np.asarray(rendered.crop(box).convert("RGB"))
            weight = np.asarray(surface.crop(box), dtype=np.float32)[:, :, None] / 255
            noise = random.standard_normal(before.shape).astype(np.float32) @ transform.T
            after = np.clip(np.rint(before.astype(np.float32) + noise*weight), 0, 255).astype("uint8")
            changed += int(np.count_nonzero(np.any(before != after, axis=2)))
            result.paste(Image.fromarray(after), (left, y))
    audit = {"version": VERSION, "applied": changed > 0,
             "source_noise_rgb_std": np.sqrt(np.diag(desired)).round(4).tolist(),
             "existing_surface_noise_rgb_std": np.sqrt(np.diag(existing)).round(4).tolist(),
             "added_noise_rgb_std": np.sqrt(remaining).round(4).tolist(),
             "source_patches": samples, "surface_patches": existing_samples,
             "surface_mask_sha256": hashlib.sha256(surface.tobytes()).hexdigest(),
             "changed_surface_pixels": changed, "changed_pixels_outside_surface": 0,
             "geometry_changed": False, "estimator": "smooth_patch_robust_high_frequency_rgb_covariance",
             "scope": "Grain is added only through the supplied surface alpha; pixels outside that mask are unchanged."}
    return result, audit
