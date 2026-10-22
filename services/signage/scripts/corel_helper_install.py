"""Install the Corel helper for the current Windows user, without admin rights."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


PROTOCOL_KEY = r'Software\Classes\signage-corel'
OWNER = 'VMApp.SignageCorel'


def check_protocol_owner(winreg):
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, PROTOCOL_KEY)
    except FileNotFoundError:
        return False
    with key:
        try:
            owner = winreg.QueryValueEx(key, 'InstalledBy')[0]
        except FileNotFoundError:
            owner = None
        if owner != OWNER:
            raise RuntimeError('Протокол signage-corel уже принадлежит другой программе.')
    return True


def install(python_home=None):
    if os.name != 'nt':
        raise RuntimeError('Установка предназначена для Windows.')
    import winreg
    source = Path(__file__).resolve().parent
    files = ['corel_helper.py', 'corel_export.py', 'corel/Create-CDR.vbs']
    version = hashlib.sha256(b''.join((source/name).read_bytes() for name in files)).hexdigest()[:16]
    root = Path(os.environ['LOCALAPPDATA'])/'SignageCorel'
    # Do not replace another application's protocol registration.
    check_protocol_owner(winreg)
    python_home = Path(python_home or Path(sys.executable).parent).resolve()
    dll = next(python_home.glob('python3??.dll'), None)
    if not dll or not (python_home/'pythonw.exe').is_file() or not (python_home/'Lib/os.py').is_file():
        raise RuntimeError('Нужна полная установленная Windows-версия Python 3.10+ с pythonw.exe.')
    runtime_id = hashlib.sha256(dll.read_bytes()).hexdigest()[:12]
    runtime = root/('runtime-'+runtime_id)
    root.mkdir(parents=True, exist_ok=True)
    if not runtime.exists():
        staging = root/('runtime-'+runtime_id+'.installing')
        staging.mkdir(exist_ok=False)
        for name in ['python.exe', 'pythonw.exe', 'python3.dll', dll.name,
                     'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']:
            if (python_home/name).is_file():
                shutil.copy2(python_home/name, staging/name)
        shutil.copytree(python_home/'Lib', staging/'Lib',
            ignore=shutil.ignore_patterns('site-packages', '__pycache__', 'test', 'tests'))
        shutil.copytree(python_home/'DLLs', staging/'DLLs', ignore=shutil.ignore_patterns('__pycache__'))
        os.replace(staging, runtime)
    app = root/'versions'/version
    app.mkdir(parents=True, exist_ok=True)
    for name in files:
        target = app/name; target.parent.mkdir(parents=True, exist_ok=True)
        data = (source/name).read_bytes()
        if target.exists() and target.read_bytes() != data:
            raise RuntimeError('Конфликт версии установленного помощника.')
        if not target.exists():
            target.write_bytes(data)
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    # Test the private GUI interpreter before registering any URL handler.
    subprocess.run([str(runtime/'pythonw.exe'), '-I', str(app/'corel_helper.py'), '--self-test'],
        check=True, timeout=30, creationflags=flags)
    command = f'"{runtime / "pythonw.exe"}" -I "{app / "corel_helper.py"}" --url "%1"'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, PROTOCOL_KEY) as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'URL:Редактор вывесок — CorelDRAW')
        winreg.SetValueEx(key, 'URL Protocol', 0, winreg.REG_SZ, '')
        winreg.SetValueEx(key, 'InstalledBy', 0, winreg.REG_SZ, OWNER)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, PROTOCOL_KEY+r'\shell\open\command') as key:
        winreg.SetValueEx(key, '', 0, winreg.REG_SZ, command)
    manifest = {'version': version, 'pythonw': str(runtime/'pythonw.exe'),
                'helper': str(app/'corel_helper.py'), 'protocol': 'signage-corel',
                'output': 'Documents/Signage Corel'}
    (root/'installation.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return manifest


def uninstall():
    import winreg
    if not check_protocol_owner(winreg):
        return
    for suffix in [r'\shell\open\command', r'\shell\open', r'\shell', '']:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, PROTOCOL_KEY+suffix)
    # Keep saved drawings and installed files for recovery; only unregister.


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python-home')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    if args.uninstall:
        uninstall(); print('Обработчик ссылок отключён. Чертежи сохранены.')
    else:
        print(json.dumps(install(args.python_home), ensure_ascii=False))
