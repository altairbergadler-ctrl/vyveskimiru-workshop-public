"""Change only the verified vm-app.ru block; leave every other site byte-for-byte intact."""
import pathlib
import sys

filename, mode = sys.argv[1:3]
source = pathlib.Path(filename).read_text()
start = source.index('vm-app.ru {')
depth = 0
end = None
for i in range(start, len(source)):
    if source[i] == '{':
        depth += 1
    elif source[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
assert end is not None
block = source[start:end]
assert '127.0.0.1:18100' in block
if mode == 'maintenance':
    assert '@workshop_maintenance' not in block
    marker = '  encode zstd gzip\n'
    assert block.count(marker) == 1
    block = block.replace(marker, marker + '''  @workshop_maintenance path /api/* /kanban /kanban/*
  handle @workshop_maintenance {
    header Cache-Control "no-store"
    header Content-Type "application/json; charset=utf-8"
    respond "{\\"error\\":\\"Обновление приложения. Повторите запрос через минуту.\\",\\"code\\":\\"MAINTENANCE\\"}" 503
  }
''')
elif mode == 'unified':
    if '127.0.0.1:18110' in block:
        assert block.count('127.0.0.1:18110') == 1
        block = block.replace('127.0.0.1:18110', '127.0.0.1:18100')
else:
    raise ValueError('Unknown route operation')
pathlib.Path(filename).write_text(source[:start] + block + source[end:])
