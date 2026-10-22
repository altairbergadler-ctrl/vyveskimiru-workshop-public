"""Check installed components and writable volumes without starting an AI job."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=30, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-login", action="store_true")
    args = parser.parse_args()
    errors = []
    print(f"Python: {sys.version.split()[0]}")
    for module in ("numpy", "PIL"):
        try:
            loaded = __import__(module)
            print(f"{module}: {loaded.__version__}")
        except ImportError:
            errors.append(f"Missing module: {module}")
    for executable in ("node", "codex"):
        if not shutil.which(executable):
            errors.append(f"Missing executable: {executable}")
            continue
        try:
            print(command([executable, "--version"]).stdout.strip())
        except (OSError, subprocess.SubprocessError):
            errors.append(f"Cannot run: {executable}")
    if shutil.which("codex"):
        try:
            help_text = command(["codex", "--help"]).stdout
            exec_text = command(["codex", "exec", "--help"]).stdout
            required = (("--no-daemon", help_text), ("--ephemeral", exec_text),
                        ("--output-schema", exec_text), ("--json", exec_text),
                        ("--skip-git-repo-check", exec_text))
            for flag, text in required:
                if flag not in text:
                    errors.append(f"Codex does not support required flag: {flag}")
            if args.require_login:
                login = command(["codex", "login", "status"])
                if "logged in using chatgpt" not in (login.stdout + login.stderr).casefold():
                    errors.append("ChatGPT login is required; API keys are not used.")
                else:
                    print("ChatGPT login: present")
        except (OSError, subprocess.SubprocessError):
            errors.append("Codex CLI check failed. Run codex login status in the container.")
    for path in (Path(os.environ.get("EDITOR_OUTPUT", "/data/jobs")),
                 Path(os.environ.get("CODEX_HOME", "/home/app/.codex"))):
        try:
            path.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=path):
                pass
            print(f"Writable: {path}")
        except OSError:
            errors.append(f"Not writable by the app user: {path}")
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    print("This check does not confirm image-generation access, quota or Linux sandbox compatibility.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
