"""Deterministic extraction of existing ink pixels; never reconstructs artwork."""
from __future__ import annotations

import math
import os
from pathlib import Path
import shutil
import tempfile

import fitz
from PIL import Image, ImageChops, ImageFilter, ImageOps, UnidentifiedImageError

from .pdf_engine import _file_sha256, _open_document

MAX_PIXELS = 24_000_000
EXTRACTION_DPI = 300
PREVIEW_WIDTH = 1600
PREVIEW_HEIGHT = 2400


def _type(value: str) -> str:
    if not isinstance(value, str) or value.lower() not in ('pdf', 'jpg', 'jpeg', 'png'):
        raise ValueError('Поддерживаются PDF и изображения JPG/PNG.')
    return 'jpg' if value.lower() == 'jpeg' else value.lower()


def _options(page: int, max_pages: int) -> None:
    if isinstance(page, bool) or not isinstance(page, int) or page < 0:
        raise ValueError('Некорректный номер страницы.')
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or not 1 <= max_pages <= 50:
        raise ValueError('Допустимый лимит страниц — от 1 до 50.')


def _document(path: str | Path, max_pages: int):
    document = _open_document(path, read_only=True)
    if len(document) > max_pages:
        document.close()
        raise ValueError('В PDF больше страниц, чем допускает лимит.')
    return document


def _image_header(source: Image.Image, source_type: str) -> None:
    expected = 'JPEG' if source_type == 'jpg' else 'PNG'
    if source.format != expected:
        raise ValueError('Формат изображения не совпадает с выбранным типом JPG/PNG.')
    if min(source.size) < 16 or max(source.size) > 20_000 or source.width * source.height > MAX_PIXELS:
        raise ValueError('Нужно изображение от 16 пикселей и не более 24 мегапикселей.')
    if getattr(source, 'n_frames', 1) != 1:
        raise ValueError('Загрузите неподвижное изображение JPG/PNG, без анимации.')


def _read_image(path: str | Path, source_type: str) -> Image.Image:
    try:
        with Image.open(path) as source:
            _image_header(source, source_type)
            source.load()
            oriented = ImageOps.exif_transpose(source)
            rgba = oriented.convert('RGBA')
            # Transparent scans are displayed against paper white, matching
            # the preview and avoiding dark RGB values behind an alpha mask.
            white = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
            rgb = Image.alpha_composite(white, rgba).convert('RGB')
            rgba.close()
            white.close()
            oriented.close()
            return rgb
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Не удалось прочитать изображение. Проверьте JPG/PNG.') from exc


def source_info(input_path: str | Path, source_type: str, max_pages: int = 50) -> dict:
    source_type = _type(source_type)
    _options(0, max_pages)
    if source_type == 'pdf':
        with _document(input_path, max_pages) as document:
            pages = [{'index': index, 'page': index, 'width': page.rect.width,
                      'height': page.rect.height, 'rotation': page.rotation}
                     for index, page in enumerate(document)]
    else:
        with _read_image(input_path, source_type) as image:
            pages = [{'index': 0, 'page': 0, 'width': image.width, 'height': image.height, 'rotation': 0}]
    return {'source_type': source_type, 'page_count': len(pages), 'pages': pages}


def _destination(input_path: str | Path, output_path: str | Path) -> Path:
    result = Path(output_path)
    if Path(input_path).resolve() == result.resolve():
        raise ValueError('Сохраните результат отдельным файлом, чтобы сохранить исходник.')
    if result.exists():
        raise ValueError('Файл результата уже существует. Выберите другое имя.')
    return result


def _save_png(image: Image.Image, output_path: Path) -> None:
    temporary = None
    created = False
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix='.stamp-extraction-', suffix='.png', dir=output_path.parent)
        os.close(descriptor)
        temporary = Path(name)
        image.save(temporary, format='PNG', compress_level=6)
        with output_path.open('xb') as target:
            created = True
            with temporary.open('rb') as source:
                shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
    except FileExistsError as exc:
        if created:
            output_path.unlink(missing_ok=True)
        raise ValueError('Файл результата уже существует. Выберите другое имя.') from exc
    except Exception:
        if created:
            output_path.unlink(missing_ok=True)
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def render_source_page(input_path: str | Path, source_type: str, page: int,
                       output_path: str | Path, max_pages: int = 50) -> dict:
    source_type = _type(source_type)
    _options(page, max_pages)
    output = _destination(input_path, output_path)
    if source_type == 'pdf':
        with _document(input_path, max_pages) as document:
            if page >= len(document):
                raise ValueError('Страница PDF не найдена.')
            original = document[page]
            width, height = original.rect.width, original.rect.height
            scale = min(PREVIEW_WIDTH / width, PREVIEW_HEIGHT / height, EXTRACTION_DPI / 72)
            pix = original.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    else:
        if page:
            raise ValueError('У изображения есть только одна страница.')
        image = _read_image(input_path, source_type)
        width, height = image.size
        image.thumbnail((PREVIEW_WIDTH, PREVIEW_HEIGHT), Image.Resampling.LANCZOS)
    try:
        _save_png(image, output)
        return {'page': page, 'width': image.width, 'height': image.height,
                'source_width': width, 'source_height': height, 'source_type': source_type}
    finally:
        image.close()


def _crop(value: dict) -> dict:
    try:
        if not isinstance(value, dict) or any(isinstance(value[key], bool) for key in ('x', 'y', 'width', 'height')):
            raise ValueError
        result = {key: float(value[key]) for key in ('x', 'y', 'width', 'height')}
        x, y, width, height = (result[key] for key in ('x', 'y', 'width', 'height'))
        if (not all(math.isfinite(number) for number in result.values()) or min(x, y) < 0
                or min(width, height) <= 0 or x + width > 1 + 1e-9 or y + height > 1 + 1e-9):
            raise ValueError
        return result
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ValueError('Выделите непустую область внутри страницы. Координаты должны быть в долях от 0 до 1.') from exc


def _region(input_path, source_type, page, crop, max_pages) -> Image.Image:
    if source_type == 'pdf':
        with _document(input_path, max_pages) as document:
            if page >= len(document):
                raise ValueError('Страница PDF не найдена.')
            source = document[page]
            rect = source.rect
            region = fitz.Rect(crop['x'] * rect.width, crop['y'] * rect.height,
                               (crop['x'] + crop['width']) * rect.width,
                               (crop['y'] + crop['height']) * rect.height)
            scale = EXTRACTION_DPI / 72
            # Render only the selected display region at 300 dpi. Large paper
            # outside the selection cannot inflate an otherwise small crop.
            pixel_width, pixel_height = math.ceil(region.width * scale), math.ceil(region.height * scale)
            if min(pixel_width, pixel_height) < 16:
                raise ValueError('Область слишком маленькая. Выделите весь оттиск с небольшим полем.')
            estimated = (pixel_width + 2) * (pixel_height + 2)
            if estimated > MAX_PIXELS:
                raise ValueError('Выделенная область слишком большая. Выделите только оттиск.')
            pix = source.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=region,
                                    colorspace=fitz.csRGB, alpha=False)
            if pix.width * pix.height > MAX_PIXELS:
                raise ValueError('Выделенная область слишком большая. Выделите только оттиск.')
            image = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    else:
        if page:
            raise ValueError('У изображения есть только одна страница.')
        with _read_image(input_path, source_type) as source:
            box = (int(crop['x'] * source.width), int(crop['y'] * source.height),
                   min(source.width, math.ceil((crop['x'] + crop['width']) * source.width)),
                   min(source.height, math.ceil((crop['y'] + crop['height']) * source.height)))
            image = source.crop(box)
    if min(image.size) < 16:
        image.close()
        raise ValueError('Область слишком маленькая. Выделите весь оттиск с небольшим полем.')
    return image


def _ink_alpha(image: Image.Image, color: str, strength: int) -> Image.Image:
    r, g, b = image.split()
    if color == 'blue':
        # The red excess penalty rejects red/brown ink, while keeping violet
        # whose blue and red channels both exceed green.
        score = ImageChops.subtract(b, ImageChops.darker(r, g))
        excess = ImageChops.subtract(r, b).point(lambda value: round(value * .4))
        score = ImageChops.subtract(score, excess)
    elif color == 'red':
        score = ImageChops.subtract(r, ImageChops.lighter(g, b))
    else:
        score = ImageOps.invert(image.convert('L'))
    radius = max(6, min(25, min(image.size) / 20))
    local = score.filter(ImageFilter.GaussianBlur(radius))
    contrast = ImageChops.subtract(score, local)
    threshold = 4 + strength * .15 if color != 'dark' else 8 + strength * .16
    absolute_threshold = 35 + strength * .6 if color != 'dark' else 100 + strength * .6
    relative_mask = contrast.point(lambda value: round(max(0, min(1, (value - threshold) / 12)) * 255))
    absolute_mask = score.point(lambda value: round(max(0, min(1, (value - absolute_threshold) / 35)) * 255))
    alpha = ImageChops.lighter(relative_mask, absolute_mask)
    if color != 'dark':
        # Black text can have a small scanner colour cast. Require meaningful
        # chroma relative to its darkness, without erasing true dark-blue ink.
        darkness = ImageOps.invert(ImageChops.darker(ImageChops.darker(r, g), b))
        weighted_darkness = darkness.point(lambda value: round(value * .8))
        boosted_score = score.point(lambda value: min(255, value * 4))
        chroma = ImageChops.subtract(boosted_score, weighted_darkness).point(lambda value: 255 if value else 0)
        alpha = ImageChops.multiply(alpha, chroma)
    return alpha


def _clear_transparent_rgb(image: Image.Image) -> None:
    # Removed document pixels must not remain recoverable by ignoring PNG
    # alpha. A hard mask leaves every partially visible source pixel intact.
    with image.getchannel('A') as alpha:
        with alpha.point(lambda value: 255 if value == 0 else 0) as removed:
            image.paste((0, 0, 0, 0), (0, 0, image.width, image.height), removed)


def extract_stamp(input_path: str | Path, output_path: str | Path, *, source_type: str,
                  crop: dict, page: int = 0, color: str = 'blue', strength: int = 50,
                  rotation: float = 0, max_pages: int = 50) -> dict:
    source_type = _type(source_type)
    _options(page, max_pages)
    selected = _crop(crop)
    if not isinstance(color, str) or color not in ('blue', 'red', 'dark'):
        raise ValueError('Выберите синий/фиолетовый, красный или тёмный оттиск.')
    if isinstance(strength, bool) or not isinstance(strength, int) or not 0 <= strength <= 100:
        raise ValueError('Сила очистки должна быть целым числом от 0 до 100.')
    if isinstance(rotation, bool) or not isinstance(rotation, (int, float)) or not math.isfinite(rotation) or abs(rotation) > 15:
        raise ValueError('Поворот оттиска должен быть от −15 до 15 градусов.')
    output = _destination(input_path, output_path)
    with _region(input_path, source_type, page, selected, max_pages) as region:
        alpha = _ink_alpha(region, color, strength)
        histogram = alpha.histogram()
        visible = sum(histogram[64:])
        coverage = visible / (region.width * region.height)
        if visible < max(24, region.width * region.height * .0005) or alpha.getextrema()[1] < 80:
            raise ValueError('Оттиск выбранного цвета не найден или слишком бледный. Уточните область, цвет или уменьшите очистку.')
        if coverage > .85:
            raise ValueError('Выделенная область похожа на сплошной фон. Выделите весь оттиск с полем или увеличьте очистку.')
        bbox = alpha.point(lambda value: 255 if value >= 16 else 0).getbbox()
        if bbox is None:
            raise ValueError('Оттиск не найден. Уточните область и цвет.')
        artwork = region.convert('RGBA')
        artwork.putalpha(alpha)
        # Preserve RGB wherever any ink remains, erase removed document RGB
        # before interpolation can bring it into a rotated image.
        _clear_transparent_rgb(artwork)
        cropped = artwork.crop(bbox)
        artwork.close()
        artwork = cropped
    if rotation:
        rotated = artwork.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(0, 0, 0, 0))
        artwork.close()
        artwork = rotated
    padding = max(3, min(12, round(max(artwork.size) * .015)))
    padded = Image.new('RGBA', (artwork.width + padding * 2, artwork.height + padding * 2), (0, 0, 0, 0))
    padded.paste(artwork, (padding, padding))
    artwork.close()
    # Rotation may create fresh fully transparent pixels. Canonicalise the
    # final downloadable PNG as well as the pre-rotation source.
    _clear_transparent_rgb(padded)
    saved = False
    try:
        _save_png(padded, output)
        saved = True
        warnings = ['При выделении тёмного оттиска чёрный текст в этой области тоже остаётся. Проверьте результат.'] if color == 'dark' else []
        return {'width': padded.width, 'height': padded.height, 'coverage': round(coverage, 6),
                'source_type': source_type, 'page': page, 'crop': selected, 'color': color,
                'strength': strength, 'rotation': float(rotation), 'dpi': EXTRACTION_DPI if source_type == 'pdf' else None,
                'padding': padding, 'warnings': warnings, 'source_sha256': _file_sha256(Path(input_path)),
                'output_sha256': _file_sha256(output)}
    except Exception:
        if saved:
            output.unlink(missing_ok=True)
        raise
    finally:
        padded.close()
