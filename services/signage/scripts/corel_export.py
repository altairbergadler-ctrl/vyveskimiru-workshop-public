"""Build an in-memory CorelDRAW handoff; never run Corel or generate CDR here."""
import io
import math
from decimal import Decimal
from pathlib import Path
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile


_SCRIPT_PATH = Path(__file__).resolve().parent / 'corel' / 'Create-CDR.vbs'
_FIELDS = frozenset({'text', 'width_cm', 'height_cm', 'line_gap_cm', 'text_align',
                     'font_family', 'font_bold', 'front_color'})
_README = """Пакет для CorelDRAW 2024 · Windows

В архиве нет готового CDR. Настоящий документ .cdr создаётся локально
установленным CorelDRAW через его интерфейс автоматизации.

1. Распакуйте весь ZIP в отдельную папку с правом записи.
   Не запускайте скрипт прямо из окна архива.
2. Убедитесь, что установлен CorelDRAW 2024 и указанный в задании шрифт.
   Перед первым использованием запустите CorelDRAW обычным способом
   и завершите его первоначальную настройку или активацию, если требуется.
3. Дважды нажмите Create-CDR.vbs в распакованной папке.
   Windows Script Host прочитает layout.xml и создаст документ в CorelDRAW
   с буквами, преобразованными в кривые.
   Запуск не требует ключа API, подписки ChatGPT или ИИ-генерации.
4. В той же папке появятся face-letters-YYYYMMDD-HHMMSS.cdr
   и текстовый отчёт. Если имя занято, используется дополнительный суффикс;
   прежние результаты не перезаписываются.
5. Откройте CDR в CorelDRAW и проверьте текст, переносы строк, шрифт,
   размеры и отчёт перед дальнейшей подготовкой к производству.

Как интерпретируются параметры

Ширина и высота в layout.xml — общие габариты всей композиции в сантиметрах,
а не высота отдельной буквы. Строки располагаются в исходном порядке;
внутренние пустые строки сохраняются. Межстрочный зазор также задан в см.
Пропорции выбранного шрифта сохраняются: надпись вписывается в заданные
ширину и высоту без растяжения по одной оси. Поэтому фактическая надпись
может занимать меньше одной из сторон рамки. Bold задаётся явно параметром
font_bold; это не автоматический подбор похожего жирного шрифта.
Векторные буквы в пакете, скачанном кнопкой редактора, чёрные (#000000).
Цвет макета на фото задаётся отдельно. При прямом обращении к API цвет
заливки по-прежнему задаётся параметром front_color в формате #RRGGBB.
Этот цвет — экранный образец, не подтверждённая цветопроба ORACAL.

Если Windows Script Host запрещён политикой компьютера или CorelDRAW
недоступен для автоматизации, автоматическое создание CDR не сработает.
Сообщение об ошибке и текстовый отчёт помогут определить причину.

Состав: layout.xml (текст и параметры), Create-CDR.vbs (постоянный скрипт),
README.txt (эта инструкция). Пакет не содержит фотографии, проекта
редактора, пароля, ключей или данных авторизации. Параметры передаются
через XML как данные и не подставляются в исполняемый код скрипта.
"""


def _number(payload, name, label, *, positive):
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{label}: требуется число.')
    try:
        number = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f'{label}: требуется конечное число.') from None
    if not math.isfinite(number):
        raise ValueError(f'{label}: требуется конечное число.')
    if positive and not 0 < number <= 10000:
        raise ValueError(f'{label}: допустимо число больше нуля и не больше 10000 см.')
    if not positive and not 0 <= number <= 10000:
        raise ValueError(f'{label}: допустимо число от 0 до 10000 см.')
    return number


def _xml_characters(value):
    return all(char in '\t\r\n' or 0x20 <= ord(char) <= 0xD7FF
               or 0xE000 <= ord(char) <= 0xFFFD
               or 0x10000 <= ord(char) <= 0x10FFFF for char in value)


def _decimal(number):
    if number == 0:
        return '0'
    # Corel's locale-independent reader accepts plain decimal notation only.
    text = format(Decimal(str(number)), 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _parameters(payload):
    if not isinstance(payload, dict):
        raise ValueError('Для CorelDRAW требуется объект с текстом и параметрами надписи.')
    if set(payload) != _FIELDS:
        raise ValueError('Для CorelDRAW передайте только текст, габариты, зазор, выравнивание, шрифт, Bold и лицевой цвет.')
    text = payload['text']
    if (not isinstance(text, str) or not _xml_characters(text)
            or len(text.encode('utf-16-le')) // 2 > 300):
        raise ValueError('Текст: не больше 300 символов, без недопустимых управляющих символов.')
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    lines = [line if line.strip() else '' for line in lines]
    if not 1 <= len(lines) <= 20:
        raise ValueError('Надпись должна содержать от 1 до 20 строк с непустым текстом.')
    width = _number(payload, 'width_cm', 'Ширина', positive=True)
    height = _number(payload, 'height_cm', 'Высота', positive=True)
    gap = _number(payload, 'line_gap_cm', 'Межстрочный зазор', positive=False)
    if len(lines) > 1 and gap >= height / (len(lines) - 1):
        raise ValueError('Межстрочные зазоры занимают всю высоту. Уменьшите зазор или увеличьте высоту композиции.')
    align = payload['text_align']
    if not isinstance(align, str) or align not in {'left', 'center', 'right'}:
        raise ValueError('Выравнивание: выберите left, center или right.')
    family = payload['font_family']
    if (not isinstance(family, str) or not 1 <= len(family) <= 120 or not family.strip()
            or not _xml_characters(family)
            or any(unicodedata.category(char) in {'Cc', 'Cf'} for char in family)):
        raise ValueError('Название шрифта: от 1 до 120 символов без управляющих знаков.')
    bold = payload['font_bold']
    if not isinstance(bold, bool):
        raise ValueError('Bold должен быть логическим значением true или false.')
    color = payload['front_color']
    if not isinstance(color, str) or re.fullmatch(r'#[0-9a-fA-F]{6}', color) is None:
        raise ValueError('Лицевой цвет должен иметь формат #RRGGBB.')
    return {'width_cm': _decimal(width), 'height_cm': _decimal(height),
            'line_gap_cm': _decimal(gap), 'text_align': align,
            'font_family': family, 'font_bold': 'true' if bold else 'false',
            'front_color': color.upper()}, lines


def normalize_specification(payload):
    """Validate the same inputs as the ZIP export and return JSON-only data."""
    fields, lines = _parameters(payload)
    return {'text': '\n'.join(lines),
            'width_cm': float(fields['width_cm']),
            'height_cm': float(fields['height_cm']),
            'line_gap_cm': float(fields['line_gap_cm']),
            'text_align': fields['text_align'], 'font_family': fields['font_family'],
            'font_bold': fields['font_bold'] == 'true', 'front_color': fields['front_color']}


def build_corel_package(payload):
    """Return a ZIP with XML parameters and an invariant Windows helper.

    Invalid input or a missing packaged helper raises a user-readable ValueError.
    No input is executed, no file is saved, and the photograph is never included.
    """
    fields, lines = _parameters(payload)
    root = ET.Element('signage', {'version': '1'})
    for name, value in fields.items():
        ET.SubElement(root, name).text = value
    text_lines = ET.SubElement(root, 'lines')
    for line in lines:
        ET.SubElement(text_lines, 'line').text = line
    ET.indent(root, space='  ')
    layout = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    try:
        # WSH reliably decodes UTF-16 with BOM, including Russian diagnostics.
        # The file is copied verbatim apart from encoding; payload is XML only.
        script = _SCRIPT_PATH.read_text(encoding='utf-8-sig').encode('utf-16')
    except (OSError, UnicodeError):
        raise ValueError('Скрипт CorelDRAW недоступен на сервере. Обновите пакет приложения.') from None
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('layout.xml', layout)
        archive.writestr('Create-CDR.vbs', script)
        archive.writestr('README.txt', _README.encode('utf-8-sig'))
    return output.getvalue()
