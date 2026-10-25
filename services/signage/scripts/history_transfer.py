"""Portable history backups. Credentials and arbitrary worker files are never included."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import zipfile

JOB_ID = re.compile(r"[a-zA-Z0-9_-]{16,80}")
FILES = frozenset({
    "project.json", "job.json", "audit.json", "image-transfer.json", "prompt.txt",
    "source.png", "lighting-base.png", "scene-base.png", "render.png", "generated.png", "thumbnail.jpg",
    "color-reference.png", "edit-mask.png", "placement-guide.png", "render-input.png", "artwork.png",
    "product-neutral.png", "product-guide.png", "layout-guide.png", "facade-grid.png", "production-spec.json", "product-stage.json",
    "installation-base.png", "front-mask.png",
    "input-project.json",
})
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 10 * 1024 * 1024 * 1024
MAX_ENTRIES = 50000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def folders_at(source):
    return sorted(p.name for p in source.iterdir()
                  if p.is_dir() and JOB_ID.fullmatch(p.name))


def export_history(source, archive):
    source, archive = Path(source).resolve(), Path(archive).absolute()
    if not source.is_dir():
        raise ValueError("History directory does not exist")
    if archive.exists():
        raise ValueError("Archive already exists; choose a new filename")
    names = folders_at(source)
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError("Job identifiers collide on case-insensitive filesystems")
    entries, observed, job_ids = [], [], []
    total = 0
    archive.parent.mkdir(parents=True, exist_ok=True)
    # Build outside the destination name so a failed backup is never mistaken for a complete one.
    with tempfile.TemporaryDirectory(prefix="history-export-", dir=archive.parent) as temp:
        pending = Path(temp) / "history.zip"
        with zipfile.ZipFile(pending, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as zipped:
            for identity in names:
                folder = source / identity
                if folder.is_symlink() or folder.resolve().parent != source:
                    raise ValueError("Linked history directories are not supported")
                if not (folder / "project.json").is_file():
                    continue
                status_file = folder / "job.json"
                if status_file.exists():
                    status = json.loads(status_file.read_text(encoding="utf-8"))
                    if status.get("status") in {"running", "queued"}:
                        raise ValueError("A generation is active; finish it before exporting")
                job_ids.append(identity)
                for name in sorted(FILES):
                    file = folder / name
                    if not file.exists():
                        continue
                    if file.is_symlink() or not file.is_file() or file.resolve().parent != folder:
                        raise ValueError("Linked history files are not supported")
                    stat = file.stat()
                    total += stat.st_size
                    if stat.st_size > MAX_FILE or total > MAX_TOTAL or len(entries) >= MAX_ENTRIES:
                        raise ValueError("History exceeds archive limits; export smaller batches")
                    data = file.read_bytes()
                    after = file.stat()
                    if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError("History changed while exporting; try when the editor is idle")
                    path = f"jobs/{identity}/{name}"
                    zipped.writestr(path, data)
                    entries.append({"path": path, "size": len(data), "sha256": sha(data),
                                    "mtime_ns": stat.st_mtime_ns})
                    observed.append((file, stat.st_size, stat.st_mtime_ns))
            if folders_at(source) != names:
                raise ValueError("A job was added while exporting; try when the editor is idle")
            for file, size, mtime in observed:
                stat = file.stat()
                if (stat.st_size, stat.st_mtime_ns) != (size, mtime):
                    raise ValueError("History changed while exporting; try when the editor is idle")
            manifest = {"format": "channel-letter-history", "version": 1,
                        "created": time.time(), "jobs": job_ids, "files": entries}
            zipped.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        # Same-filesystem link atomically publishes the complete ZIP without overwriting.
        # If the filesystem lacks hard links, fail with no incomplete final archive.
        os.link(pending, archive)
    return {"jobs": len(job_ids), "files": len(entries), "bytes": total,
            "archive": str(archive)}


def import_history(archive, destination):
    archive, destination = Path(archive), Path(destination).absolute()
    if destination.is_symlink():
        raise ValueError("Linked destination is not supported")
    destination.mkdir(parents=True, exist_ok=True)
    destination = destination.resolve()
    with zipfile.ZipFile(archive) as zipped:
        infos = zipped.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)) or len(names) > MAX_ENTRIES + 1:
            raise ValueError("Invalid or oversized archive index")
        if "manifest.json" not in names or zipped.getinfo("manifest.json").file_size > 16 * 1024 * 1024:
            raise ValueError("Missing or oversized manifest")
        manifest = json.loads(zipped.read("manifest.json"))
        if manifest.get("format") != "channel-letter-history" or manifest.get("version") != 1:
            raise ValueError("Unsupported history archive")
        jobs, entries = manifest.get("jobs"), manifest.get("files")
        if not isinstance(jobs, list) or not isinstance(entries, list):
            raise ValueError("Invalid manifest")
        if any(not isinstance(j, str) or not JOB_ID.fullmatch(j) for j in jobs) or len(set(jobs)) != len(jobs):
            raise ValueError("Invalid job identifiers")
        if len({identity.casefold() for identity in jobs}) != len(jobs):
            raise ValueError("Job identifiers collide on case-insensitive filesystems")
        existing = {p.name.casefold() for p in destination.iterdir()}
        if any(identity.casefold() in existing for identity in jobs):
            raise ValueError("Job already exists at destination; existing history was not overwritten")
        checked, total = [], 0
        for entry in entries:
            path = entry.get("path", "")
            parts = path.split("/")
            if len(parts) != 3 or parts[0] != "jobs" or parts[1] not in jobs or parts[2] not in FILES:
                raise ValueError("Unexpected archive path")
            size, mtime = entry.get("size"), entry.get("mtime_ns")
            if not isinstance(size, int) or not 0 <= size <= MAX_FILE or not isinstance(mtime, int) or mtime < 0:
                raise ValueError("Invalid file metadata")
            total += size
            if total > MAX_TOTAL or path not in names or zipped.getinfo(path).file_size != size:
                raise ValueError("Invalid archive size")
            checked.append(path)
        if len(set(checked)) != len(checked) or set(names) != set(checked) | {"manifest.json"}:
            raise ValueError("Archive and manifest do not match")
        if any(f"jobs/{identity}/project.json" not in checked for identity in jobs):
            raise ValueError("A job has no project.json")
        # Validate every checksum before publishing any restored job.
        with tempfile.TemporaryDirectory(prefix=".history-import-", dir=destination) as temp:
            staging = Path(temp)
            for entry in entries:
                data = zipped.read(entry["path"])
                if sha(data) != entry.get("sha256"):
                    raise ValueError("Checksum mismatch; history has not been imported")
                _, identity, name = entry["path"].split("/")
                target = staging / identity / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(data)
                os.utime(target, ns=(entry["mtime_ns"], entry["mtime_ns"]))
            published = []
            try:
                for identity in jobs:
                    target = destination / identity
                    if target.exists():
                        raise ValueError("Destination changed during import; stop the editor before importing")
                    (staging / identity).rename(target)
                    published.append(identity)
            except Exception:
                # Only move back directories published by this import. The archive is untouched.
                for identity in reversed(published):
                    try:
                        (destination / identity).rename(staging / identity)
                    except OSError as rollback_error:
                        raise ValueError(f"Import partially restored {published}; rollback failed. Keep the archive and inspect destination.") from rollback_error
                raise
    return {"jobs": len(jobs), "files": len(entries), "bytes": total,
            "destination": str(destination)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("--source", type=Path, required=True)
    export.add_argument("--archive", type=Path, required=True)
    restore = commands.add_parser("import")
    restore.add_argument("--archive", type=Path, required=True)
    restore.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = export_history(args.source, args.archive) if args.command == "export" else import_history(args.archive, args.destination)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"History transfer failed: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
