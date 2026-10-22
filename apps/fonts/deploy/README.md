# Публикация тестового каталога

Каталог публикуется отдельно по `https://vm-app.ru/fonts/`. Installer не управляет
Docker, Finance PWA, `/signs/` или их данными. Релизы сохраняются в
`/srv/signage-font-catalog/releases`, `current` — атомарно переключаемая ссылка.

После окончательной проверки UI упаковать неизменяемый снимок `dist`:

```powershell
python scripts/package-static.py --output qa/package-20261012-beta-v1
```

Выход: `font-gallery.tar.gz` и `manifest.json` с точным списком файлов, размерами
и SHA-256. Максимум 600 файлов, менее 180 MiB в распакованном виде. Ссылки,
Windows reparse points, скрытые пути, неизвестные типы файлов запрещены.
Существующий пакет не перезаписывается.

Перед публикацией перечитать live `/etc/caddy/Caddyfile`, убедиться, что
актуальные чужие маршруты сохраняются, получить его свежий SHA-256. Перенести
архив, manifest и `deploy/install-static.py` в отдельный закрытый staging-каталог
VPS. Затем выполнить на VPS:

```sh
python3 /path/to/staging/install-static.py \
  --archive /path/to/staging/font-gallery.tar.gz \
  --manifest /path/to/staging/manifest.json \
  --expected-caddy FRESH_SHA256_OF_CADDYFILE \
  --release 20261012-beta-v1
```

Скрипт проверяет manifest и tar до распаковки; принимает только объявленные
обычные файлы и необходимые обычные каталоги. Проверяет SHA-256 всех файлов на
диске, ссылки font/catalog/license, Caddy candidate, исходный SHA и неизменность
конфигурации перед заменой. Первый выпуск добавляет только собственный marker
block `/fonts/`, последующие выпуски переключают только `current`.

Проверка публикации включает HTTPS-хеши HTML, CSS, обоих JS, JSON каталога и пяти
равномерно выбранных файлов шрифтов; все файлы повторно проверяются на диске.
Фоновые изменения других сервисов записываются в evidence и не откатываются.
Файлы beta возвращают `Cache-Control: no-store` и `X-Robots-Tag: noindex, nofollow`.
JS, CSS и шрифты хостятся локально. Встроенный JavaScript не разрешён.
Canvas PNG download использует blob URL.

Обновление AR от 14 октября 2026 мигрирует только известный собственный блок
`/fonts/`: `connect-src` разрешает blob для локальных GLB, `script-src` добавляет
`wasm-unsafe-eval` для WebAssembly внутри 3D-библиотеки (JavaScript eval остаётся
запрещён), `style-src` допускает динамические стили model-viewer. Скрипты и
зависимости по-прежнему локальные. Installer распознаёт точный прежний блок и
новый; неизвестные изменения останавливают публикацию. При откате миграции
возвращаются прежний блок и ссылка `current`, с сохранением чужих маршрутов.
HTTPS-проверка дополнительно охватывает страницу примерки и все её JS/CSS.

Evidence и полный manifest: закрытый файл
`/srv/signage-font-catalog/deployments/20261012-beta-v1.json`. Installer после
успеха сохраняется в `/srv/signage-font-catalog/deploy/install-static.py`.

Ручной откат своего последнего выпуска:

```sh
python3 /srv/signage-font-catalog/deploy/install-static.py \
  --rollback /srv/signage-font-catalog/deployments/20261012-beta-v1.json
```

Для первого выпуска откат удаляет только точный собственный marker block из
**свежего** Caddy, validate/reload, затем возвращает прежний `current`. Для
обновления откат возвращает только ссылку. Более новый каталог блокирует откат
устаревшего evidence. Старые релизы не удаляются.

При неудачном reload полная предыдущая конфигурация восстанавливается только
если действующий файл всё ещё в точности равен собственному candidate. Если
за это время изменился Caddy, чужой файл не заменяется и не перезагружается:
ссылка каталога откатывается, случай фиксируется для ручного обследования.

Защита от параллельного изменения: собственный lock + общий advisory lock
`/etc/caddy/codex-route.deploy.lock` + сравнение байтов непосредственно перед
заменой. Другие инструменты должны использовать этот общий lock для полной
взаимной блокировки: filesystem не предоставляет атомарный conditional rename
для произвольного writer, который игнорирует lock. Во время публикации избегать
других изменений Caddy.

Локальная проверка безопасности без VPS:

```powershell
python -m unittest discover -s tests -p test_deployment_safety.py -v
```
