# Finance PWA · Мастерская

Единый сервер Мастерской для `vm-app.ru`: финансы, заказы, производство и склад.
Google Таблица хранит бизнес-данные и расчёты; SQLite — сессии, квитанции и диагностику.
Заказы `/kanban/` включены модулем в общий сервер. CRM `/crm/`
временно отключена с сохранением данных; клиенты доступны внутри заказов.
[Checkpoint отключения CRM](../workshop-crm-2026-09-05/PAUSED.md).

- [Единая архитектура всей Мастерской](ARCHITECTURE.md) — страницы, функции,
  источники данных, связи, API, вход, развёртывание и резервирование.
- [Глубокий аудит от 6 сентября 2026](docs/ARCHITECTURE_AUDIT_2026-09-06.md) —
  подтверждённые ограничения, воспроизведённые дефекты и порядок исправлений.
- [Android-виджеты](android-widget/README.md).
- [Варианты упрощения архитектуры](docs/ARCHITECTURE_SIMPLIFICATION_PROPOSAL.md) —
  исходное направление переделки: Google Таблица остаётся мозгом и хранилищем,
  общий веб-интерфейс и сервер автоматизируют работу с ней.
- [Карта листов, полей и команд](docs/SHEETS_CONTRACT_MAP.md) — все 16 листов,
  границы записи, зависимости формул и код для сохранения, объединения и замены.

## Runtime

- `npm run build` builds the mobile-first PWA into `dist/client`.
- `npm start` serves the PWA and API.
- `DATA_DIR` stores `finance.sqlite3`.
- `APP_PIN_HASH` is a salted scrypt hash; the PIN is never stored in source.
- `GOOGLE_CREDENTIALS_FILE` points to a Google service-account JSON file with writer access to the spreadsheet.

Financial business values come directly from Google. A successful command is returned only after read-back;
the same request ID recovers an uncertain response without blindly repeating the write. Legacy replica
tables remain as an inactive archive for rollback. Use `deploy/install-workshop.sh` for a complete release.
See [CHECKPOINT.md](CHECKPOINT.md) for the actual deployment and acceptance status.
