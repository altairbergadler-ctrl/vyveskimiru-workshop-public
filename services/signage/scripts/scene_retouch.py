"""Explicit optional whole-photo cleanup, before deterministic product placement."""
import hashlib
import json
import numpy as np

REMOVALS = {
    'foreign_signs': 'unrelated commercial signs and their lettering',
    'litter': 'litter, rubbish and loose waste',
    'people': 'people and their personal belongings',
    'visual_clutter': 'temporary notices, stray objects and distracting incidental urban clutter',
}


def validate(project):
    raw = project.get('generation', {}).get('scene_retouch')
    if raw is None:
        return {'mode': 'off', 'removals': []}
    if not isinstance(raw, dict) or raw.get('mode', 'off') not in ('off', 'ideal_environment'):
        raise ValueError('Выберите режим ретуши окружения.')
    mode = raw.get('mode', 'off')
    values = raw.get('removals', list(REMOVALS))
    if not isinstance(values, list) or any(not isinstance(v, str) or v not in REMOVALS for v in values) or len(values) != len(set(values)):
        raise ValueError('Неверные категории ретуши окружения.')
    if mode != 'off' and not values:
        raise ValueError('Выберите хотя бы одну категорию для ретуши.')
    return {'mode': mode, 'removals': [key for key in REMOVALS if key in values]}


def prompt(settings, quad, scale, work_size, *, local_cleanup=False):
    spec = {'operation': 'ideal_environment_cleanup', 'remove': [REMOVALS[key] for key in settings['removals']],
            'photo_content_size_px': list(work_size), 'new_product_in_ai': False,
            'installation_zone_px': [[round(x * scale, 2), round(y * scale, 2)] for x, y in quad],
            'remove_old_sign_inside_installation_zone': local_cleanup}
    return ('Edit the photograph into a clean, realistic ideal environment for an architectural signage presentation. '
            'Image 1 is the photograph with the selected ambient lighting already applied. Image 2 is a guide only; '
            'never copy its outlines into the result. Remove ONLY the selected categories in the JSON below across the photograph. '
            'Reconstruct the background naturally where these objects stood. Retain every category that is not selected. '
            'Preserve camera, crop, aspect ratio, perspective, facade proportions, wall outlines, doors, windows, paving, '
            'permanent building equipment, structural cables/pipes and street geometry. Do not improve or remodel the building. '
            'Do not move structural features or change ambient illumination. Do not invent a new facade. '
            'The padded area beyond photo_content_size_px is not photograph content. '
            'If remove_old_sign_inside_installation_zone is true, additionally erase existing signage and its shadow only '
            'within that installation polygon, restoring its wall finish. Otherwise no additional local cleanup is requested. '
            'Do not add any new sign, letters, logo, text, QR, panel, fixture or glow. The exact new product is placed afterwards. '
            'Return the edited photograph only at the same canvas framing, without outlines or overlays.\n'
            + json.dumps(spec, ensure_ascii=False))


def audit(before, after, settings):
    if before.size != after.size:
        raise ValueError('Ретушь изменила размер кадра.')
    original, cleaned = np.asarray(before.convert('RGB')), np.asarray(after.convert('RGB'))
    return {'enabled': True, 'mode': settings['mode'], 'removals': settings['removals'],
            'scope': 'whole_photo_before_product_placement',
            'changed_pixels_from_lighting_base': int(np.count_nonzero(np.any(original != cleaned, axis=2))),
            'lighting_base_pixels_sha256': hashlib.sha256(original.tobytes()).hexdigest(),
            'scene_base_pixels_sha256': hashlib.sha256(cleaned.tobytes()).hexdigest(),
            'source_spatial_transform': 'identity', 'architecture_preservation': 'prompt_constraint_requires_visual_review',
            'new_product_in_ai': False}
