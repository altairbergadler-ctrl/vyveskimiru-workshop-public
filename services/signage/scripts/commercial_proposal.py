"""PDF offers from immutable, completed signage variants. No AI or project writes.

The pricing engine is the verbatim calculator.mjs published on vm-app.ru on
2026-10-16. It is applied once per independent sign, including its support range.
Unknown costs are never treated as zero or included in a turnkey total.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
from xml.sax.saxutils import escape

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle

import product_render

ROOT = Path(__file__).resolve().parents[1]
STYLES = {"presentation": "Презентационное", "technical": "Техническое", "compact": "Компактное"}
ID = r"[a-f0-9]{32}"
CALCULATOR_SHA = "c6653ffe63371d0e6cfe5540aa347fefb9e8ede5abc318a58e00003ea9c5979f"
BENEFITS = [
    ("Внешний вид до изготовления", "Показываем изделие на фотографии вашего фасада: проще согласовать масштаб, размещение и сочетание цветов."),
    ("Понятная комплектация", "Фиксируем надписи, размеры, цвета и материалы каждого изделия в одном документе."),
    ("Прозрачный состав стоимости", "Изготовление, прототипирование и монтаж выделены отдельно. Несогласованные позиции видны до начала работ."),
]
_font_lock = threading.Lock()
_build_lock = threading.Lock()


class ProposalError(ValueError):
    pass


def _finite(value, label, maximum=10_000_000):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= maximum:
        raise ProposalError("Не подтверждён размер: " + label)
    return value


def options(raw):
    if not isinstance(raw, dict):
        raise ProposalError("Проверьте условия КП.")
    result = {}
    if type(raw.get("demo_terms", True)) is not bool:
        raise ProposalError("Проверьте отметку демо-условий.")
    result["demo_terms"] = raw.get("demo_terms", True)
    for key in ("prototype", "installation", "delivery"):
        value = raw.get(key)
        if value in (None, ""):
            result[key] = None
        else:
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 100_000_000:
                raise ProposalError("Проверьте стоимость: " + key)
            result[key] = int(math.floor(value * 100 + .5))
    for key, length in (("client", 120), ("contact", 200), ("deadline", 160), ("warranty", 200),
                        ("payment", 240), ("validity", 120), ("tax", 160), ("benefits", 800)):
        value = raw.get(key, "")
        if not isinstance(value, str) or len(value) > length or any(ord(c) < 32 and c != "\n" for c in value):
            raise ProposalError("Слишком длинное или некорректное поле: " + key)
        result[key] = value.strip()
    return result


def source(service, job_id):
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", job_id):
        raise ProposalError("Выберите готовый вариант из истории.")
    job = service.public(job_id)
    if job.get("status") != "complete":
        raise ProposalError("КП можно собрать после завершения варианта.")
    project_bytes = service.artifact(job_id, "project.json").read_bytes()
    spec = json.loads(service.artifact(job_id, "production-spec.json").read_bytes())
    project = json.loads(project_bytes)
    if spec.get("source", {}).get("project_sha256") != hashlib.sha256(project_bytes).hexdigest():
        raise ProposalError("Спецификация не соответствует сохранённому варианту.")
    product = product_render.active_product(project)
    if spec.get("product_type") != "channel_letters" or product_render.renderer_family(product) != "channel_letters":
        raise ProposalError("Демо КП пока поддерживает объёмные буквы с сохранённой спецификацией.")
    params = product["params"]
    originals = {obj["id"]: obj for obj in params.get("objects", [])}
    objects = []
    for item in spec.get("objects", []):
        obj = originals.get(item.get("id"))
        if not obj:
            raise ProposalError("Объект отсутствует в сохранённом проекте.")
        decoder = product_render.decode_logo_artwork if obj.get("type") == "logo" else product_render.decode_artwork
        img, image_bytes = decoder(obj.get("artwork"))
        if hashlib.sha256(image_bytes).hexdigest() != item.get("source_input", {}).get("artwork", {}).get("sha256"):
            raise ProposalError("Исходное изображение изделия изменилось.")
        dims = item.get("front_dimensions_cm", {})
        width, height = _finite(dims.get("width"), "ширина"), _finite(dims.get("height"), "высота")
        height_input = obj.get("letter_height_cm")
        priceable = obj.get("type") == "text" and obj.get("height_basis") == "body" and "\n" not in obj.get("text", "").strip()
        if priceable:
            _finite(height_input, "тело буквы")
        objects.append({"id": obj["id"], "type": obj.get("type"), "text": obj.get("text") or "Логотип",
                        "width": width, "height": height, "letter_height": height_input,
                        "depth": item.get("depth_cm"), "front": item.get("front_color"),
                        "side": item.get("return_color"), "font": obj.get("font_family", ""),
                        "bold": obj.get("font_bold"), "x": obj.get("x_cm", 0), "y": obj.get("y_cm", 0),
                        "rotation": obj.get("rotation_deg", 0), "brief": obj.get("brief", ""),
                        "materials": item.get("material_input", {}), "artwork": img,
                        "artwork_sha256": hashlib.sha256(image_bytes).hexdigest(), "priceable": priceable})
    if not 1 <= len(objects) <= 20:
        raise ProposalError("Нет готовых объектов со спецификацией.")
    model = {"job_id": job_id, "project_id": job.get("project_id"), "name": job.get("text") or "Вывески для фасада",
             "objects": objects, "spec": spec, "project_sha256": hashlib.sha256(project_bytes).hexdigest(),
             "render": service.artifact(job_id, "render.png"), "source": service.artifact(job_id, "source.png"),
             "warnings": spec.get("installation_reference", {}).get("accuracy_notes", [])}
    model["pricing"] = calculate(objects)
    return model


def calculate(objects):
    calculator = ROOT / "assets/proposal-calculator.mjs"
    if hashlib.sha256(calculator.read_bytes()).hexdigest() != CALCULATOR_SHA:
        raise ProposalError("Версия калькулятора не подтверждена.")
    data = [{"widthCm": o["width"], "heightCm": o["height"],
             "letters": [{"text": o["text"], "heightCm": o["letter_height"]}], "film": False, "cassette": False}
            if o["priceable"] else None for o in objects]
    code = "import{pathToFileURL}from'node:url';const{calculate}=await import(pathToFileURL(process.argv[1]));let s='';for await(const d of process.stdin)s+=d;process.stdout.write(JSON.stringify(JSON.parse(s).map(x=>x?calculate(x):null)))"
    run = subprocess.run([shutil.which("node") or "node", "--input-type=module", "-e", code, str(calculator)],
                         input=json.dumps(data), capture_output=True, text=True, encoding="utf-8", timeout=15,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if run.returncode:
        raise ProposalError("Калькулятор временно недоступен.")
    rows = json.loads(run.stdout)
    for row in rows:
        if row is not None and not row.get("ok"):
            raise ProposalError("Размеры не подходят для текущей формулы калькулятора.")
    complete = all(row is not None for row in rows)
    return {"rows": rows, "complete": complete,
            "min": sum(row["totalMinCents"] for row in rows if row),
            "max": sum(row["totalMaxCents"] for row in rows if row),
            "formula": "calculator-v1-20261012", "calculator_sha256": CALCULATOR_SHA,
            "basis": "each_independent_sign_with_its_own_support_range"}


def public_source(model):
    return {"job_id": model["job_id"], "name": model["name"], "project_sha256": model["project_sha256"],
            "objects": [{k: v for k, v in o.items() if k not in {"artwork", "materials"}} for o in model["objects"]],
            "pricing": model["pricing"], "warnings": model["warnings"]}


def create(service, body):
    opts = options(body.get("options", {}))
    style = body.get("style", "all")
    if style not in {*STYLES, "all"}:
        raise ProposalError("Неизвестное оформление.")
    if not _build_lock.acquire(blocking=False):
        raise ProposalError("Другое КП ещё формируется. Повторите через несколько секунд.")
    try:
        model = source(service, body.get("job_id"))
        identity = secrets.token_hex(16)
        base = service.output.parent / "proposals"
        base.mkdir(exist_ok=True, mode=0o700)
        pending = base / (".pending-" + identity)
        pending.mkdir(mode=0o700)
        selected = list(STYLES) if style == "all" else [style]
        result = {"id": identity, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                  "source": public_source(model), "options": opts, "files": []}
        try:
            for name in selected:
                filename = name + ".pdf"
                data = render_pdf(model, opts, name, identity)
                (pending / filename).write_bytes(data)
                result["files"].append({"style": name, "title": STYLES[name], "filename": filename,
                                        "url": "proposals/" + identity + "/" + filename,
                                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            (pending / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
            pending.rename(base / identity)
        except Exception:
            # Leave a private incomplete build for diagnostics; it is never served.
            raise
        return result
    finally:
        _build_lock.release()


def download(service, identity, name):
    if not re.fullmatch(ID, identity) or name not in {s + ".pdf" for s in STYLES}:
        raise FileNotFoundError()
    folder = service.output.parent / "proposals" / identity
    manifest = json.loads((folder / "manifest.json").read_bytes())
    record = next((r for r in manifest["files"] if r["filename"] == name), None)
    if not record:
        raise FileNotFoundError()
    data = (folder / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ProposalError("Файл КП не прошёл проверку целостности.")
    return data


def manifest(service, identity):
    if not isinstance(identity, str) or not re.fullmatch(ID, identity):
        raise FileNotFoundError()
    return json.loads((service.output.parent / "proposals" / identity / "manifest.json").read_bytes())


def money(cents):
    amount = cents / 100
    return (f"{amount:,.0f}" if amount.is_integer() else f"{amount:,.2f}").replace(",", " ").replace(".", ",") + " ₽"


def num(value):
    return f"{value:.1f}".rstrip("0").rstrip(".").replace(".", ",")


def fonts():
    with _font_lock:
        if "VM" in pdfmetrics.getRegisteredFontNames():
            return
        candidates = [Path("/usr/share/fonts/truetype/dejavu"), Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"]
        for folder in candidates:
            regular = folder / ("DejaVuSans.ttf" if (folder / "DejaVuSans.ttf").exists() else "arial.ttf")
            bold = folder / ("DejaVuSans-Bold.ttf" if (folder / "DejaVuSans-Bold.ttf").exists() else "arialbd.ttf")
            if regular.exists() and bold.exists():
                pdfmetrics.registerFont(TTFont("VM", str(regular)))
                pdfmetrics.registerFont(TTFont("VM-Bold", str(bold)))
                pdfmetrics.registerFontFamily("VM", normal="VM", bold="VM-Bold", italic="VM", boldItalic="VM-Bold")
                return
        raise ProposalError("Для PDF недоступен шрифт с кириллицей.")


class Document:
    W, H = 595.276, 841.89

    def __init__(self, stream, model, opts, style, identity):
        fonts()
        self.c = canvas.Canvas(stream, pagesize=(self.W, self.H), pageCompression=1)
        self.c.setTitle("Коммерческое предложение · ВывескиМиру · " + STYLES[style])
        self.c.setAuthor("ВывескиМиру")
        self.m, self.opts, self.style, self.identity = model, opts, style, identity
        self.page = 0
        self.ink = "#152b31"
        self.muted = "#627478"
        self.accent = {"presentation": "#b34f2d", "technical": "#126a7b", "compact": "#216c50"}[style]

    def rect(self, x, y, w, h, fill, stroke=None, radius=0):
        self.c.setFillColor(colors.HexColor(fill))
        self.c.setStrokeColor(colors.HexColor(stroke or fill))
        if radius:
            self.c.roundRect(x, self.H-y-h, w, h, radius, fill=1, stroke=bool(stroke))
        else:
            self.c.rect(x, self.H-y-h, w, h, fill=1, stroke=bool(stroke))

    def line(self, x1, y1, x2, y2, color=None, width=.65):
        self.c.setStrokeColor(colors.HexColor(color or self.accent)); self.c.setLineWidth(width)
        self.c.line(x1, self.H-y1, x2, self.H-y2)

    def text(self, value, x, y, size=10, color=None, bold=False, width=None):
        value = str(value)
        if width is not None:
            p = Paragraph(escape(value).replace("\n", "<br/>"), ParagraphStyle("t", fontName="VM-Bold" if bold else "VM",
                          fontSize=size, leading=size*1.45, textColor=colors.HexColor(color or self.ink)))
            _, height = p.wrap(width, 2000)
            p.drawOn(self.c, x, self.H-y-height)
            return height
        self.c.setFillColor(colors.HexColor(color or self.ink))
        self.c.setFont("VM-Bold" if bold else "VM", size)
        self.c.drawString(x, self.H-y-size, value)
        return size

    def image(self, image, x, y, w, h, background=None):
        if background:
            self.rect(x, y, w, h, background, radius=5)
        if not isinstance(image, Image.Image):
            with Image.open(image) as opened:
                image = opened.convert("RGB")
        image = image.copy()
        image.thumbnail((max(1, round(w*2.5)), max(1, round(h*2.5))), Image.Resampling.LANCZOS)
        if image.mode == "RGB":
            compressed = io.BytesIO()
            image.save(compressed, "JPEG", quality=90, optimize=True)
            compressed.seek(0)
            reader = ImageReader(compressed)
        else:
            reader = ImageReader(image)
        scale = min(w/image.width, h/image.height)
        iw, ih = image.width*scale, image.height*scale
        self.c.drawImage(reader, x+(w-iw)/2, self.H-y-(h+ih)/2, iw, ih, mask="auto")

    def start(self, label):
        if self.page:
            self.c.showPage()
        self.page += 1
        self.rect(0, 0, self.W, 8, self.accent)
        self.text("ВЫВЕСКИМИРУ", 36, 26, 12, bold=True)
        self.text(label, 335, 28, 8, self.muted)
        self.line(36, 59, 559, 59, "#dce3e3")
        self.line(36, 795, 559, 795, "#dce3e3")
        self.text("КП " + self.identity[:8].upper() + " · " + dt.datetime.now().strftime("%d.%m.%Y"), 36, 808, 7.5, self.muted)
        self.text(STYLES[self.style] + " · " + str(self.page), 370, 808, 7.5, self.muted)
        if self.opts["demo_terms"]:
            self.text("ДЕМО · Условия и стоимость дополнительных работ предложены для согласования", 36, 66, 6.4, self.accent)

    def title(self, eyebrow, title, sub=None):
        self.text(eyebrow.upper(), 36, 80, 8, self.accent, True)
        self.text(title, 36, 101, 25, bold=True, width=523)
        if sub:
            self.text(sub, 36, 145, 9, self.muted, width=523)

    def price(self, y, small=False):
        p = self.m["pricing"]
        additions = sum(self.opts[k] or 0 for k in ("prototype", "installation", "delivery"))
        unpriced = any(self.opts[k] is None for k in ("prototype", "installation", "delivery")) or not p["complete"]
        self.rect(36, y, 523, 92 if small else 108, "#f0f4f1", radius=7)
        label = "РАССЧИТАННАЯ ЧАСТЬ" if unpriced else "ПРЕДВАРИТЕЛЬНАЯ СТОИМОСТЬ"
        self.text(label, 52, y+13, 8, self.accent, True)
        amount = money(p["min"]+additions) + " - " + money(p["max"]+additions) if any(p["rows"]) else "По согласованию"
        self.text(amount, 52, y+32, 22 if small else 26, bold=True)
        note = "Без несогласованных работ. Итог после уточнения комплектации." if unpriced else "По формуле калькулятора и указанным дополнительным работам."
        self.text(note, 52, y+68, 8, self.muted, width=488)

    def benefits(self, y, compact=False):
        self.text("Почему удобно заказать у нас", 36, y, 16, bold=True)
        y += 33
        for i, (title, body) in enumerate(BENEFITS):
            self.text(f"0{i+1}", 36, y, 12, self.accent, True)
            self.text(title, 70, y, 10, bold=True)
            height = self.text(body, 70, y+18, 8.5, self.muted, width=475)
            y += (height + 32 if not compact else height + 27)
        if self.opts["benefits"] and not compact:
            y += self.text(self.opts["benefits"], 36, y, 9, width=523)+12
        return y

    def arrow(self, x1, y1, x2, y2, label, vertical=False):
        self.line(x1, y1, x2, y2)
        angle = math.atan2(y2-y1, x2-x1)
        for x, y, direction in ((x1, y1, 1), (x2, y2, -1)):
            for delta in (-.48, .48):
                self.line(x, y, x+direction*5*math.cos(angle+delta), y+direction*5*math.sin(angle+delta))
        if vertical:
            self.text(label, x2+6, (y1+y2)/2-4, 7, self.accent)
        else:
            self.text(label, (x1+x2)/2-pdfmetrics.stringWidth(label, "VM", 7)/2, y1-14, 7, self.accent)

    def object_diagram(self, o, index, x, y, width, height):
        self.rect(x, y, width, height, "#f5f7f7", "#e0e6e6", 6)
        self.text(f"{index:02d}  " + o["text"], x+14, y+12, 11, bold=True, width=width-28)
        zone_x, zone_y, zone_w, zone_h = x+24, y+56, width-100, height-103
        scale = min(zone_w/o["width"], zone_h/o["height"])
        iw, ih = o["width"]*scale, o["height"]*scale
        ix, iy = zone_x+(zone_w-iw)/2, zone_y+(zone_h-ih)/2
        self.image(o["artwork"], ix, iy, iw, ih, "#34484d")
        self.arrow(ix, iy-12, ix+iw, iy-12, num(o["width"])+" см")
        self.arrow(ix+iw+12, iy, ix+iw+12, iy+ih, num(o["height"])+" см", True)
        self.line(ix, iy-4, ix, iy-18, "#a1b5b8"); self.line(ix+iw, iy-4, ix+iw, iy-18, "#a1b5b8")
        self.text("Тело букв: " + (num(o["letter_height"])+" см" if o["letter_height"] else "не задано") +
                  "   ·   Глубина: " + (num(o["depth"])+" см" if o["depth"] else "уточнить"), x+14, y+height-31, 7.5, self.muted, width=width-28)
        self.text("Размерные стрелки показывают полный габарит", x+14, y+height-17, 6.5, self.muted)

    def material(self, o, x, y, width):
        self.text(o["text"], x, y, 12, bold=True, width=width)
        y += 25
        for label, value in (("Лицевая часть", o["front"]), ("Борт", o["side"])):
            fill = value if isinstance(value, str) and re.fullmatch(r"#[\da-fA-F]{6}", value) else "#cccccc"
            self.rect(x, y+2, 13, 13, fill, "#a8b7b9", 2)
            self.text(label + ": " + (value or "уточнить"), x+21, y, 8.5, width=width-21)
            y += 24
        m = o["materials"]
        construction = m.get("construction") or {}
        face = construction.get("face") or {}
        returns = construction.get("returns") or {}
        labels = {"acrylic": "акрил", "aluminium": "алюминий"}
        details = ["Лицо: " + labels.get(face.get("material"), "материал уточняется") + "; борт: " + labels.get(returns.get("material"), "материал уточняется") + "."]
        film = m.get("shared_face_material") or {}
        if film.get("type") == "film_on_acrylic":
            details.append("Плёнка " + (film.get("brand") or "") + (" " + film["series"] if film.get("series") else "") + (" " + film["color_code"] if film.get("color_code") else ": серия и код уточняются") + ".")
        details.append("Толщина материалов и температура LED: " + (str(film["led_temperature_k"])+" K" if film.get("led_temperature_k") else "требуют согласования") + ".")
        if o["font"]:
            details.append("Шрифт: " + o["font"] + (", полужирный." if o["bold"] else "."))
        if o["brief"]:
            details.append(o["brief"])
        return y + self.text("\n".join(details), x, y, 8.3, self.muted, width=width)

    def schedule(self, y):
        values = [("Срок изготовления", "deadline"), ("Гарантия", "warranty"), ("Оплата", "payment"),
                  ("Срок действия КП", "validity"), ("Налоги / НДС", "tax"), ("Связаться с нами", "contact")]
        for label, key in values:
            self.text(label, 36, y, 8.5, self.muted)
            h = self.text(self.opts[key] or "Согласуем перед заказом", 209, y, 8.5, width=350)
            y += max(24, h+10)
        return y

    def budget(self, y):
        self.text("Изготовление и работы", 36, y, 19, bold=True)
        y += 37
        self.rect(36, y, 523, 25, "#eaf0f0")
        self.text("Состав", 47, y+6, 8, bold=True)
        self.text("Стоимость", 415, y+6, 8, bold=True)
        y += 34
        for o, row in zip(self.m["objects"], self.m["pricing"]["rows"]):
            self.text(o["text"], 47, y, 9, bold=True, width=335)
            if row:
                r = row["letterRows"][0]
                self.text(money(row["lettersCents"]), 415, y, 9, bold=True)
                self.text(f"{r['count']} симв. × {num(r['heightCm'])} см × {r['rate']} ₽/см", 47, y+17, 7.5, self.muted)
            else:
                self.text("По согласованию", 415, y, 8)
                self.text("Для этого объекта нет подтверждённой формулы", 47, y+17, 7.5, self.muted)
            y += 42
        count = sum(row is not None for row in self.m["pricing"]["rows"])
        self.line(36, y, 559, y, "#dce3e3"); y += 12
        self.text("Питание и каркас", 47, y, 9, bold=True)
        self.text(money(count*200000)+" - "+money(count*600000), 385, y, 9, bold=True)
        self.text(f"{count} независимых изделий × 2 000 - 6 000 ₽; состав уточняется", 47, y+18, 7.5, self.muted)
        y += 48
        for title, key in (("Прототипирование / образец", "prototype"), ("Монтаж", "installation"), ("Доставка", "delivery")):
            self.text(title, 47, y, 9)
            self.text("Не рассчитано" if self.opts[key] is None else money(self.opts[key]), 415, y, 8.5)
            if self.opts[key] is not None:
                qty = len(self.m["objects"]) if key == "installation" else 1
                if self.opts[key] % qty == 0:
                    self.text(str(qty) + (" изделия" if key == "installation" else " услуга") + " × " + money(self.opts[key] // qty), 47, y+14, 6.5, self.muted)
            y += 28
        self.text("Дополнительная плёнка и композитная кассета в эту оценку не добавлены. Их расход и стоимость согласуем по конструкции.", 36, y+3, 7.5, self.muted, width=523)
        return y+44


def render_pdf(model, opts, style, identity):
    stream = io.BytesIO()
    d = Document(stream, model, opts, style, identity)
    objects = model["objects"]
    if style == "presentation":
        d.start("КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ")
        d.title("Вывески для вашего фасада", "Бизнес, который замечают", opts["client"] or "Индивидуальное решение по готовому проекту")
        d.image(model["render"], 36, 187, 523, 368, "#e8edeb")
        d.text("Сохранённая визуализация выбранного варианта", 36, 563, 8, d.muted)
        d.text(" / ".join(o["text"] for o in objects), 36, 589, 12, bold=True, width=523)
        d.price(644)
        d.text("Внешний вид и размеры согласуем до запуска в производство.", 36, 766, 8, d.muted)
    elif style == "technical":
        d.start("ТЕХНИЧЕСКОЕ ПРЕДЛОЖЕНИЕ")
        d.title("Проект / спецификация", "Точность в каждой детали", opts["client"] or "Комплектация, схема и стоимость изготовления")
        d.image(model["render"], 36, 182, 523, 300, "#e8edeb")
        d.text("Состав проекта", 36, 500, 15, bold=True)
        y = 535
        for index, o in enumerate(objects[:6], 1):
            d.text(f"{index:02d}  {o['text']}", 36, y, 10, bold=True, width=285)
            d.text(f"{num(o['width'])} × {num(o['height'])} см", 350, y, 9)
            y += 27
        d.text("Полный габарит включает верхние и нижние выступы. Тело букв указано на схемах отдельно.", 36, y+8, 8.5, d.muted, width=523)
        d.text("Основа КП: сохранённый вариант " + model["job_id"][:18] + "…", 36, 758, 7.5, d.muted)
    else:
        d.start("КОМПАКТНОЕ ПРЕДЛОЖЕНИЕ")
        d.title("Ваш проект / наглядно", "Вывески для фасада", opts["client"] or "Решение, комплектация и предварительная оценка")
        d.image(model["render"], 36, 181, 523, 248, "#e8edeb")
        d.price(445, True)
        d.benefits(560, True)

    if style == "compact" and len(objects) <= 4:
        d.start("2D / МАТЕРИАЛЫ / ЦВЕТ")
        d.title("Размеры и комплектация", "Все изделия в деталях", "Вид спереди. Размерные стрелки показывают полный габарит; тело букв указано отдельно.")
        for i, o in enumerate(objects):
            x, y = 36+(i%2)*268, 186+(i//2)*278
            d.object_diagram(o, i+1, x, y, 255, 180)
            d.text("Лицо " + (o["front"] or "уточнить") + " · борт " + (o["side"] or "уточнить"), x, y+191, 7.5)
            mat = o["materials"].get("construction") or {}
            names = {"acrylic": "акрил", "aluminium": "алюминий"}
            face = names.get((mat.get("face") or {}).get("material"), "уточнить")
            returns = names.get((mat.get("returns") or {}).get("material"), "уточнить")
            film = o["materials"].get("shared_face_material") or {}
            material_line = "Лицо: " + face + "; борт: " + returns + ("; плёнка ORACAL" if film.get("type")=="film_on_acrylic" else "")
            d.text(material_line, x, y+208, 7.3, d.muted, width=250)
            if o["brief"]:
                d.text(o["brief"][:190], x, y+237, 7.1, d.muted, width=250)
        d.text("Экранные цвета сверяем с образцом. Толщины, LED, крепёж, код плёнки и контрольные размеры согласуем до изготовления.", 36, 752, 7.5, d.muted, width=523)
        d.start("СМЕТА / УСЛОВИЯ ЗАКАЗА")
        y = d.budget(86)
        d.price(y+6, True)
        d.schedule(y+112)
        d.c.save()
        return stream.getvalue()

    # Two dimensional front views retain the original PNGs, without redrawing text.
    for offset in range(0, len(objects), 4):
        d.start("2D / РАЗМЕРЫ ИЗДЕЛИЙ")
        d.title("Геометрия / сантиметры", "Так устроен ваш проект", "Вид спереди. Надписи взяты из исходных макетов; пропорции каждого изделия сохранены.")
        for i, o in enumerate(objects[offset:offset+4]):
            x, y = 36+(i%2)*268, 192+(i//2)*229
            d.object_diagram(o, offset+i+1, x, y, 255, 212)
        d.text("Схемы приведены в индивидуальном масштабе. Положение изделий показано на фасадном макете.", 36, 660, 8, d.muted, width=523)
        d.text("Крепление и питание", 36, 696, 12, bold=True)
        d.rect(41, 730, 5, 35, "#a6b5b4"); d.rect(66, 735, 21, 25, "#34484d")
        d.arrow(48, 748, 64, 748, "")
        d.line(87, 744, 122, 727)
        d.text("Корпус / глубина по спецификации", 128, 714, 8, width=360)
        d.text("Отступ от стены, крепёж, трасса кабеля и место блока питания согласуются после осмотра фасада.", 128, 737, 8, d.muted, width=414)

    for offset in range(0, len(objects), 4):
        d.start("МАТЕРИАЛЫ / ЦВЕТ / КОНСТРУКЦИЯ")
        d.title("Спецификация", "Цвет и характер вывески", "Цвета из проекта переданы в HEX. Физический оттенок согласуется по образцу материала.")
        for i, o in enumerate(objects[offset:offset+4]):
            d.material(o, 36+(i%2)*268, 191+(i//2)*265, 247)
        d.text("До изготовления подтвердим", 36, 730, 12, bold=True)
        d.text("Толщины, марки материалов, подсветку, крепёж и исходные векторные контуры. Размеры на фото проверяются контрольным замером.", 36, 753, 8, d.muted, width=523)

    # Long projects paginate the budget rather than overflowing a fixed page.
    for offset in range(0, len(objects), 6):
        original_objects, original_pricing = model["objects"], model["pricing"]
        model["objects"] = original_objects[offset:offset+6]
        model["pricing"] = original_pricing | {"rows": original_pricing["rows"][offset:offset+6]}
        d.start("СМЕТА / ИЗГОТОВЛЕНИЕ И РАБОТЫ")
        y = d.budget(86)
        model["objects"], model["pricing"] = original_objects, original_pricing
        if offset+6 >= len(objects):
            d.price(y+10, True)
            y += 116
            d.text("Основа расчёта", 36, y, 11, bold=True)
            d.text("Действующая формула калькулятора ВывескиМиру: 100 ₽/см для тела букв 15-50 см включительно, иначе 150 ₽/см. Питание и каркас учтены отдельно для каждой независимой вывески. Это новая предварительная оценка выбранного варианта по формуле, а не ранее утверждённая смета.", 36, y+22, 8, d.muted, width=523)
        else:
            d.text("Продолжение сметы на следующей странице. Общая оценка приведена после всех изделий.", 36, y+20, 8, d.muted, width=523)

    d.start("УСЛОВИЯ / СЛЕДУЮЩИЙ ШАГ")
    d.title("От проекта к готовой вывеске", "Согласуем и изготовим")
    y = 170
    if style != "compact":
        y = d.benefits(y)+15
    else:
        d.text("01  Утверждаем внешний вид и комплектацию\n02  Проверяем размеры и монтажные условия\n03  Фиксируем стоимость, сроки и запускаем заказ", 36, y, 10, width=523)
        y += 85
    y = d.schedule(y)
    d.text("Что ещё сделает предложение убедительнее", 36, y+13, 11, bold=True)
    d.text("Фотографии похожих выполненных работ, отзыв клиента, подтверждённый срок, условия гарантии и образец материала можно добавить к следующей версии КП.", 36, y+35, 8.5, d.muted, width=523)
    d.text("КП составлено по сохранённому варианту. Фотомакет показывает внешний вид, а 2D-схемы - размеры из проекта. Контрольный замер, конструкция и несогласованные работы подтверждаются до заказа.", 36, 722, 7.5, d.muted, width=523)
    d.text("Вариант: " + model["job_id"], 36, 768, 6.5, d.muted)
    d.c.save()
    return stream.getvalue()
