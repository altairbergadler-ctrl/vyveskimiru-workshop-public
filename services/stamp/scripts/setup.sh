#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"

fail() { printf '%s\n' "$*" >&2; exit 1; }

show_password=false
if [[ -t 1 ]]; then show_password=true; fi
for argument in "$@"; do
  case "$argument" in
    --no-print-password) show_password=false ;;
    --help|-h)
      printf '%s\n' 'Использование: bash scripts/setup.sh [--no-print-password]'
      printf '%s\n' 'Пароль выводится только в интерактивном терминале. В автоматическом запуске он остаётся в .env.'
      exit 0 ;;
    *) fail "Неизвестный параметр: $argument" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail 'Не найден Docker. Сначала установите Docker Engine и Compose на VPS.'
docker compose version >/dev/null 2>&1 || fail 'Не найден Docker Compose v2 (docker compose).'
docker info >/dev/null 2>&1 || fail 'Нет доступа к Docker daemon. Запустите установщик от пользователя с доступом к Docker.'
[[ ! -L .env ]] || fail 'Файл .env не должен быть символической ссылкой.'
[[ ! -L data ]] || fail 'Каталог data не должен быть символической ссылкой.'

generated_password=''
if [[ ! -e .env ]]; then
  generated_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  [[ ${#generated_password} -eq 64 ]] || fail 'Не удалось сгенерировать пароль.'
  # noclobber avoids overwriting an existing .env even if another setup starts.
  (
    set -o noclobber
    sed "s/^APP_PASSWORD=REPLACE_WITH_RANDOM_PASSWORD$/APP_PASSWORD=$generated_password/" .env.example > .env
  )
  printf '%s\n' 'Создан .env с новым случайным паролем.'
else
  [[ -f .env ]] || fail '.env должен быть обычным файлом.'
  printf '%s\n' 'Используется существующий .env; пароль и настройки сохранены.'
fi
chmod 600 .env

if rg_placeholder=$(sed -n '/^APP_PASSWORD=REPLACE_WITH_RANDOM_PASSWORD$/p' .env) && [[ -n "$rg_placeholder" ]]; then
  fail 'В .env остался пример пароля. Замените APP_PASSWORD на длинный случайный пароль.'
fi

mkdir -p -- data
docker compose config --quiet
docker compose build

# Only the project data directory is mounted, never the Docker socket or host root.
# This sets ownership of the directory itself; existing documents are not rewritten.
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  --security-opt no-new-privileges:true --pids-limit 32 --memory 64m \
  --volume "$project_dir/data:/data" --entrypoint /bin/sh \
  stamp-service:local -c 'chown 10001:10001 /data && chmod 0700 /data'

docker compose up -d
printf '%s\n' 'Ожидание запуска сервиса...'
healthy=false
for attempt in {1..30}; do
  if docker compose exec -T stamp python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).close()" \
    >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  fail 'Сервис пока не отвечает. Проверьте: docker compose logs --tail=100 stamp. Данные и .env сохранены.'
fi

host_port="$(sed -n 's/^HOST_PORT=//p' .env | tail -n 1)"
host_port="${host_port:-8187}"
base_path="$(sed -n 's/^APP_BASE_PATH=//p' .env | tail -n 1)"
base_path="${base_path%/}"
secure_cookie="$(sed -n 's/^COOKIE_SECURE=//p' .env | tail -n 1)"
printf '\nКонтейнер запущен; внутренний адрес: http://127.0.0.1:%s%s/\n' "$host_port" "$base_path"
printf 'На своём компьютере откройте SSH-туннель:\n  ssh -N -L 8187:127.0.0.1:%s openclaw-vps\n' "$host_port"
if [[ "$secure_cookie" == true ]]; then
  printf '%s\n' 'COOKIE_SECURE=true: входите через HTTPS-адрес настроенного reverse proxy. Сам установщик не публикует сайт.'
else
  printf 'Затем откройте в браузере: http://127.0.0.1:8187%s/\n' "$base_path"
fi
if [[ -n "$generated_password" && "$show_password" == true ]]; then
  printf '\nЛогин: admin\nПароль: %s\n' "$generated_password"
  printf '%s\n' 'Сохраните пароль в менеджере паролей. Он также хранится в приватном файле .env на VPS.'
else
  printf '%s\n' 'Логин и пароль — значения APP_USERNAME и APP_PASSWORD из приватного .env. Пароль в этот вывод не включён.'
fi
