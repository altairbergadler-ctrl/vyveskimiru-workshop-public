"""Offline automatic placement for trusted PDF inputs and shell automation."""
import argparse
from pathlib import Path
import sys
from PIL import Image
from .pdf_engine import inspect_pdf, stamp_pdf


def main():
    parser = argparse.ArgumentParser(description='Поставить печать только при однозначном совпадении ИНН и поля М.П.')
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--stamp', required=True, type=Path)
    parser.add_argument('--inn', default='7700000000')
    parser.add_argument('--company', default='Тестовая компания')
    parser.add_argument('--width-mm', default=35.6, type=float)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve() or args.output.exists():
        parser.error('Выходной файл уже существует или совпадает с исходным. Укажите новое имя.')
    try:
        with Image.open(args.stamp) as stamp:
            aspect = stamp.height / stamp.width
        info = inspect_pdf(args.input, args.inn, args.company, args.width_mm, aspect)
        index = info['auto_candidate_index']
        if index is None:
            print('Автоматическое размещение неоднозначно. Откройте документ в веб-интерфейсе.', file=sys.stderr)
            return 2
        result = stamp_pdf(args.input, args.output, args.stamp, info['candidates'][index])
        print(args.output)
        return 0
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
