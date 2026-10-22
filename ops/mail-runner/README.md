# Коннектор почты на VPS

Сервер: openclaw-vps. Исполнение: отдельный пользователь workshop-mail, Codex CLI 0.157.1, gpt-5.6-terra, reasoning low. Каждый проход — новая ephemeral сессия без истории чата. Установлено 10 октября 2026.

## Запуск и данные

- /opt/workshop-mail-runner — root-owned код, Linux runbook, prompt и schema.
- /var/lib/workshop-mail — закрытые авторизация и краткие результаты. last-result.json — последний результат, results.jsonl — максимум 200 итогов без писем/транскриптов.
- /data/mail-assistant-v2 внутри finance-pwa — прежние курсоры, журнал решений и lease. Данные не мигрировались и не сбрасывались.
- workshop-mail.timer — каждые 30 минут 10:00–20:30 Europe/Moscow, пропущенные ночные запуски не догоняются.
- sudo разрешает только фиксированный Node entrypoint в finance-pwa. Пользователь не входит в docker group. Скрипты на хосте ему недоступны для записи.
- Авторизация ChatGPT взята из уже авторизованного серверного помощника; секреты в пакет не включены. Присланный в чат SSH-ключ не устанавливался.

## Контроль

    systemctl status workshop-mail.timer workshop-mail.service
    cat /var/lib/workshop-mail/last-result.json
    journalctl -u workshop-mail.service -n 20
    systemctl start workshop-mail.service

Service не запускается второй раз одновременно; file lock и lease дополнительно защищают от других проходов. После процесса выполняется finish только со своим RunId. При timeout убивается группа процессов до освобождения lease. Секреты и полные ответы инструментов не сохраняются в результатах.

## Уведомления

До выбора владельцем канала исходящие уведомления отключены. NOTIFY/DONT_NOTIFY и новые вопросы сохраняются в last-result.json/results.jsonl. Ответы владельца необходимо передать агенту отдельно; этот серверный процесс не читает историю локального чата.

## Откат

    systemctl disable --now workshop-mail.timer

Дождаться завершения активного service и закрытия lease. Затем включить прежнюю automation-2 через Codex. Не включать два расписания одновременно. Данные, авторизацию, журнал и исходники при откате не удалять.
