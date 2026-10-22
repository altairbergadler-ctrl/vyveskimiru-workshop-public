"""Bounded, one-use, in-memory handoff of letter parameters to native CorelDRAW.

The server never sends executable helper code, receives local file contents, or
creates an AI job. A restart deliberately invalidates all short-lived tickets.
"""
from __future__ import annotations

import re
import secrets
import threading
import time
import unicodedata

from corel_export import normalize_specification


TOKEN_PATTERN = r"[0-9a-f]{64}"
MAX_JSON_BYTES = 8192


class LaunchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _token_equal(actual, expected):
    return (isinstance(actual, str) and re.fullmatch(TOKEN_PATTERN, actual) is not None
            and secrets.compare_digest(actual, expected))


def _safe_text(value, limit):
    return (isinstance(value, str) and 0 < len(value) <= limit
            and not any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value))


class CorelLaunches:
    def __init__(self, *, clock=time.monotonic, pending_ttl=300, claimed_ttl=900,
                 retention=900, capacity=128):
        self.clock = clock
        self.pending_ttl = pending_ttl
        self.claimed_ttl = claimed_ttl
        self.retention = retention
        self.capacity = capacity
        self.entries = {}
        self.lock = threading.Lock()

    def _cleanup(self, now):
        for identity, entry in list(self.entries.items()):
            if entry["status"] in {"pending", "claimed"} and now >= entry["deadline"]:
                entry.update(status="expired", terminal_at=entry["deadline"])
                entry.pop("specification", None)
                entry.pop("completion_token", None)
            if "terminal_at" in entry and now >= entry["terminal_at"] + self.retention:
                del self.entries[identity]

    def _get(self, identity, now):
        self._cleanup(now)
        entry = self.entries.get(identity)
        if entry is None:
            raise LaunchError(404, "Запрос CorelDRAW не найден или уже удалён. Создайте новый запрос.")
        return entry

    @staticmethod
    def _public(identity, entry, now):
        result = {"id": identity, "status": entry["status"],
                  "expires_in": max(0, int(entry["deadline"] - now))
                  if entry["status"] in {"pending", "claimed"} else 0}
        for key in ("message", "filename"):
            if key in entry:
                result[key] = entry[key]
        return result

    def create(self, payload):
        specification = normalize_specification(payload)
        with self.lock:
            now = self.clock()
            self._cleanup(now)
            # Retained terminal records can yield space; active requests never do.
            while len(self.entries) >= self.capacity:
                terminal = next((key for key, item in self.entries.items() if "terminal_at" in item), None)
                if terminal is None:
                    raise LaunchError(429, "Слишком много запросов CorelDRAW. Дождитесь завершения или истечения срока.")
                del self.entries[terminal]
            identity = secrets.token_hex(32)
            while identity in self.entries:
                identity = secrets.token_hex(32)
            status_token = secrets.token_hex(32)
            self.entries[identity] = {"status": "pending", "specification": specification,
                                      "status_token": status_token, "deadline": now + self.pending_ttl}
        return {"id": identity, "launch_url": "signage-corel://open/" + identity,
                "status_token": status_token, "expires_in": self.pending_ttl}

    def status(self, identity, token):
        with self.lock:
            now = self.clock()
            entry = self._get(identity, now)
            if not _token_equal(token, entry["status_token"]):
                raise LaunchError(403, "Недопустимый ключ проверки CorelDRAW.")
            return self._public(identity, entry, now)

    def claim(self, identity, body):
        if not isinstance(body, dict) or body:
            raise LaunchError(400, "Для получения задания передайте пустой JSON-объект.")
        with self.lock:
            now = self.clock()
            entry = self._get(identity, now)
            if entry["status"] == "expired":
                raise LaunchError(410, "Срок запуска CorelDRAW истёк. Создайте новый запрос в редакторе.")
            if entry["status"] != "pending":
                raise LaunchError(409, "Этот запрос CorelDRAW уже был получен. Повторный запуск не выполняется.")
            token = secrets.token_hex(32)
            specification = entry.pop("specification")
            entry.update(status="claimed", completion_token=token, deadline=now + self.claimed_ttl)
            return {"specification": specification, "completion_token": token}

    def complete(self, identity, body):
        if (not isinstance(body, dict) or not {"completion_token", "status"} <= set(body)
                or not set(body) <= {"completion_token", "status", "message", "filename"}
                or body["status"] not in ("complete", "failed")):
            raise LaunchError(400, "Неверный результат CorelDRAW.")
        if "message" in body and not _safe_text(body["message"], 300):
            raise LaunchError(400, "Сообщение CorelDRAW должно содержать до 300 символов без управляющих знаков.")
        filename = body.get("filename")
        if "filename" in body and (not _safe_text(filename, 160) or not filename.lower().endswith(".cdr")
                                     or any(char in filename for char in '<>:"/\\|?*')
                                     or filename in {".cdr", "..cdr"} or filename[0] in {" ", "."}):
            raise LaunchError(400, "Передайте только имя CDR без пути к файлу.")
        with self.lock:
            now = self.clock()
            entry = self._get(identity, now)
            if entry["status"] == "expired":
                raise LaunchError(410, "Срок ожидания CorelDRAW истёк.")
            if not _token_equal(body["completion_token"], entry.get("completion_token", "")):
                raise LaunchError(403, "Недопустимый ключ завершения CorelDRAW.")
            if entry["status"] != "claimed":
                fields = ("status", "message", "filename")
                if ({key: entry[key] for key in fields if key in entry}
                        == {key: body[key] for key in fields if key in body}):
                    # The native helper may have lost the response after saving.
                    # An identical report cannot rerun Corel or change the result.
                    return self._public(identity, entry, now)
                raise LaunchError(409, "Результат CorelDRAW уже сохранён и не может быть изменён.")
            entry.update(status=body["status"], terminal_at=now)
            for key in ("message", "filename"):
                if key in body:
                    entry[key] = body[key]
            return self._public(identity, entry, now)
