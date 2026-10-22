"""Transactional project drafts and job membership, separate from immutable jobs.

SQLite transactions make the draft, its original photo and revision one commit.
The database lives beside jobs in the persistent data volume. Back it up with
sqlite3.Connection.backup(), which includes committed WAL data, or stop the app
before copying the entire projects directory.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

ID_PATTERN = r"[a-zA-Z0-9_-]{16,96}"
JOB_PATTERN = r"[a-zA-Z0-9_-]{16,80}"
MAX_DRAFT_BYTES = 30 * 1024 * 1024


class ProjectError(ValueError):
    pass


class Conflict(ProjectError):
    def __init__(self, revision, message="Проект уже изменён на другом компьютере. Откройте его актуальную версию."):
        super().__init__(message)
        self.revision = revision


def valid_id(identity):
    if not isinstance(identity, str) or not re.fullmatch(ID_PATTERN, identity):
        raise ProjectError("Неверный идентификатор проекта.")
    if identity.startswith("legacy-") and not re.fullmatch(JOB_PATTERN, identity[7:]):
        raise ProjectError("Неверный идентификатор сохранённого проекта.")
    return identity


def valid_job(identity):
    if not isinstance(identity, str) or not re.fullmatch(JOB_PATTERN, identity):
        raise ProjectError("Неверный идентификатор варианта.")
    return identity


def json_text(value):
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_DRAFT_BYTES:
            raise ProjectError("Черновик превышает 30 МБ.")
        # Limit nesting before persistence; parse recursion otherwise depends on
        # the process stack rather than an explicit JSON contract.
        def check(item, depth=0):
            if depth > 48:
                raise ProjectError("Слишком сложная структура черновика.")
            if isinstance(item, dict):
                for child in item.values():
                    check(child, depth + 1)
            elif isinstance(item, list):
                for child in item:
                    check(child, depth + 1)
        check(value)
        return text
    except (TypeError, ValueError, RecursionError) as exc:
        if isinstance(exc, ProjectError):
            raise
        raise ProjectError("Черновик должен содержать корректный JSON.") from exc


def suggested_name(snapshot):
    project = snapshot.get("project", {})
    sign = project.get("sign", {})
    text = sign.get("text", "") if isinstance(sign, dict) else ""
    if isinstance(text, str) and text.strip():
        return " ".join(text.split())[:160]
    image = project.get("image", {})
    name = image.get("name", "") if isinstance(image, dict) else ""
    return name.strip()[:160] if isinstance(name, str) and name.strip() else "Новый проект"


class Store:
    def __init__(self, root, photo_decoder):
        self.root = Path(root).resolve()
        self.path = self.root / "projects.sqlite3"
        self.photo_decoder = photo_decoder

    def _check_path(self):
        if self.path.resolve().parent != self.root or self.path.is_symlink():
            raise ProjectError("Недопустимый путь хранилища проектов.")

    @contextmanager
    def connection(self, write=False):
        self._check_path()
        if not write and not self.path.exists():
            yield None
            return
        if write:
            self.root.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            if write:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA synchronous=FULL")
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, updated_at REAL NOT NULL, snapshot TEXT NOT NULL, generation TEXT NOT NULL, photo_hash TEXT)")
                connection.execute("CREATE TABLE IF NOT EXISTS photos (hash TEXT PRIMARY KEY, data_url TEXT NOT NULL)")
                connection.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created REAL NOT NULL)")
                connection.execute("CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY, target_id TEXT NOT NULL)")
            else:
                connection.execute("BEGIN")
                if not connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").fetchone():
                    # Another process may be creating the first draft. A
                    # pre-schema snapshot is simply the empty project store.
                    yield None
                    return
            yield connection
            if write:
                connection.commit()
        except Exception:
            if write:
                connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _resolve(connection, identity):
        if connection is None:
            return identity
        seen = set()
        while True:
            if identity in seen:
                raise ProjectError("Повреждена связь проектов.")
            seen.add(identity)
            alias = connection.execute("SELECT target_id FROM aliases WHERE id=?", (identity,)).fetchone()
            if alias is None:
                return identity
            identity = alias["target_id"]

    def resolve(self, identity):
        valid_id(identity)
        with self.connection() as connection:
            return self._resolve(connection, identity)

    @classmethod
    def _job_project(cls, connection, identity):
        row = connection.execute("SELECT project_id FROM jobs WHERE id=?", (identity,)).fetchone() if connection else None
        return cls._resolve(connection, row["project_id"] if row else "legacy-" + identity)

    def project_for_job(self, identity):
        valid_job(identity)
        with self.connection() as connection:
            return self._job_project(connection, identity)

    @staticmethod
    def _metadata(row):
        return {key: row[key] for key in ("id", "name", "revision", "updated_at")}

    def records(self):
        with self.connection() as connection:
            if connection is None:
                return []
            rows = connection.execute("SELECT id,name,revision,updated_at FROM projects").fetchall()
            return [self._metadata(row) for row in rows if self._resolve(connection, row["id"]) == row["id"]]

    def load(self, identity):
        valid_id(identity)
        with self.connection() as connection:
            if connection is None:
                return None
            identity = self._resolve(connection, identity)
            row = connection.execute("SELECT * FROM projects WHERE id=?", (identity,)).fetchone()
            if row is None:
                return None
            snapshot = json.loads(row["snapshot"])
            if row["photo_hash"]:
                photo = connection.execute("SELECT data_url FROM photos WHERE hash=?", (row["photo_hash"],)).fetchone()
                if photo is None:
                    raise ProjectError("Исходное фото проекта не найдено.")
                snapshot["photo"] = photo["data_url"]
            else:
                snapshot["photo"] = ""
            return self._metadata(row) | {"snapshot": snapshot, "generation": json.loads(row["generation"])}

    def validate(self, body):
        if not isinstance(body, dict):
            raise ProjectError("Не передан черновик проекта.")
        revision = body.get("base_revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ProjectError("Не передана версия проекта.")
        snapshot = body.get("snapshot")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("project"), dict) or not isinstance(snapshot.get("photo"), str):
            raise ProjectError("Черновик должен содержать проект и исходное фото.")
        generation = body.get("generation")
        if generation is not None and not isinstance(generation, dict):
            raise ProjectError("Неверное состояние генерации.")
        # Incomplete calibration/form fields are legitimate drafts. Do not run
        # generation validation or normalize away their UI/interaction state.
        json_text(body)
        snapshot = json.loads(json_text(snapshot))
        photo = snapshot.pop("photo")
        if photo:
            decoded = self.photo_decoder(photo)
            image = snapshot["project"].get("image")
            if not isinstance(image, dict) or [image.get("width_px"), image.get("height_px")] != list(decoded.size):
                raise ProjectError("Фото и координаты черновика не совпадают.")
        name = body.get("name", suggested_name(snapshot))
        if not isinstance(name, str) or not name.strip() or len(name) > 160 or any(ord(c) < 32 for c in name):
            raise ProjectError("Название проекта должно содержать от 1 до 160 символов.")
        photo_hash = hashlib.sha256(photo.encode("utf-8")).hexdigest() if photo else None
        return revision, name.strip(), snapshot, generation, photo, photo_hash

    def save(self, identity, body, *, legacy_exists=False):
        valid_id(identity)
        revision, name, snapshot, generation, photo, photo_hash = self.validate(body)
        with self.connection(write=True) as connection:
            canonical = self._resolve(connection, identity)
            current = connection.execute("SELECT revision FROM projects WHERE id=?", (canonical,)).fetchone()
            actual = current["revision"] if current else 0
            if canonical != identity:
                raise Conflict(actual, "Проект объединён с другим. Откройте объединённый проект.")
            if identity.startswith("legacy-") and current is None and not legacy_exists:
                raise ProjectError("Сохранённый проект не найден.")
            if revision != actual:
                raise Conflict(actual)
            if photo_hash:
                connection.execute("INSERT OR IGNORE INTO photos(hash,data_url) VALUES (?,?)", (photo_hash, photo))
            updated = time.time()
            connection.execute("INSERT INTO projects(id,name,revision,updated_at,snapshot,generation,photo_hash) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,updated_at=excluded.updated_at,snapshot=excluded.snapshot,generation=excluded.generation,photo_hash=excluded.photo_hash",
                               (identity, name, actual + 1, updated, json_text(snapshot), json_text(generation), photo_hash))
            return {"id": identity, "name": name, "revision": actual + 1, "updated_at": updated}

    def link_job(self, identity, project_id, created, *, source_job_id=None, legacy_exists=False):
        valid_job(identity)
        valid_id(project_id)
        if source_job_id is not None:
            valid_job(source_job_id)
        with self.connection(write=True) as connection:
            project_id = self._resolve(connection, project_id)
            existing = connection.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone()
            if existing is None and not (project_id.startswith("legacy-") and legacy_exists):
                raise ProjectError("Сначала сохраните проект на сервере.")
            if source_job_id and self._job_project(connection, source_job_id) != project_id:
                raise ProjectError("Исходный вариант принадлежит другому проекту.")
            row = connection.execute("SELECT project_id FROM jobs WHERE id=?", (identity,)).fetchone()
            if row is not None and self._resolve(connection, row["project_id"]) != project_id:
                raise ProjectError("Вариант уже относится к другому проекту.")
            connection.execute("INSERT OR IGNORE INTO jobs(id,project_id,created) VALUES (?,?,?)", (identity, project_id, created))
            connection.execute("UPDATE projects SET updated_at=? WHERE id=?", (created, project_id))
            return project_id

    def merge(self, project_ids, target_id, seeds):
        if not isinstance(project_ids, list) or not 2 <= len(project_ids) <= 100:
            raise ProjectError("Выберите от 2 до 100 разных проектов.")
        for identity in project_ids:
            valid_id(identity)
        if len(set(project_ids)) != len(project_ids):
            raise ProjectError("Выберите разные проекты.")
        valid_id(target_id)
        if target_id not in project_ids:
            raise ProjectError("Итоговый проект должен входить в выбранную группу.")
        prepared = {identity: self.validate(body) for identity, body in seeds.items()}
        with self.connection(write=True) as connection:
            if any(self._resolve(connection, identity) != identity for identity in project_ids):
                raise ProjectError("Группа уже изменена. Обновите историю проектов.")
            for identity in project_ids:
                if connection.execute("SELECT id FROM projects WHERE id=?", (identity,)).fetchone() is None:
                    if identity not in prepared:
                        raise ProjectError("Один из проектов не найден.")
                    _, name, snapshot, generation, photo, photo_hash = prepared[identity]
                    if photo_hash:
                        connection.execute("INSERT OR IGNORE INTO photos(hash,data_url) VALUES (?,?)", (photo_hash, photo))
                    connection.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?)", (identity, name, 0, time.time(), json_text(snapshot), json_text(generation), photo_hash))
            for identity in project_ids:
                if identity != target_id:
                    connection.execute("INSERT INTO aliases(id,target_id) VALUES (?,?)", (identity, target_id))
            # Keep the target's exact draft but invalidate editors that opened it
            # before the merge, so a concurrent stale save cannot erase decisions.
            connection.execute("UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?", (time.time(), target_id))
            row = connection.execute("SELECT id,name,revision,updated_at FROM projects WHERE id=?", (target_id,)).fetchone()
            return self._metadata(row)
