#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""PreToolUse guard: stop raw patient identifiers from entering the model's context.

Wired to Read, Grep, the shells, IDE code execution, Artifact and SendUserFile --
anything that can put a file's content in context or send it off the machine.
Reads the hook payload on stdin, works out which
files the tool could read, and scans each one with ``deid.py``. For any file that
still carries identifiers it writes a de-identified twin under ``deid/`` and
denies the call, naming the twin so the work can continue against that instead.

Failure policy: a crash here returns "ask", not "allow" and not "deny". Failing
open would defeat the guard; failing closed on a bug would block every read in the
project. Handing the decision to the user is the only honest third option.

Bash is the hard case, because a command is free text. Paths are recovered by
splitting on shell punctuation as well as whitespace, translating Git Bash /c/...
paths and expanding globs; directories are walked only when a recursive reader
(grep -r, rg, findstr, xargs, find -exec) could open them. It stays heuristic -- a
path assembled at runtime still slips through -- so raw captures belong outside
the project tree, with this guard as the second line of defence, not the first.
It only looks inside the project, the configured raw capture directories and
Downloads: files elsewhere are never scanned, walked or copied.

One exception: a command that does nothing but run tools/deid.py or
tools/deid_verify.py under Python is trusted without scanning. Those tools print
only counts or de-identified text, and without the exception the guard would block
the very commands it recommends. Chaining, piping, redirection or substitution
anywhere in the command voids it.

Every invocation is appended to guard.log next to the salt (outside the repo and
outside OneDrive): time, tool, decision. Never a path -- capture filenames have
carried chart numbers before. Scan results are cached there too, keyed by a hash
of the path and invalidated whenever the file or deid.py changes. Both files are
the guard's own state and are exempt from scanning (their timestamps look like
dates, so the guard would otherwise lock itself out of its own audit log).
"""
from __future__ import annotations

import datetime
import glob
import hashlib
import json
import re
import shlex
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import deid  # noqa: E402

# Shell-like tools get their command parsed for paths; every other covered tool
# gets its whole input walked for strings that name existing files.
SHELL_TOOLS = {"Bash": "command", "PowerShell": "command", "mcp__ide__executeCode": "code"}
CONTENT_TOOLS = {"Read", "Grep", "Artifact", "SendUserFile"} | set(SHELL_TOOLS)
TRUSTED_SCRIPTS = {HERE / "deid.py", HERE / "deid_verify.py"}

STATE_DIR = deid._default_salt_path().parent
STATE_FILES = {"guard.log", "scan_cache.json"}
DOWNLOADS = (Path.home() / "Downloads").resolve()

SKIP_DIRS = {".git", "__pycache__", "node_modules", "deid"}
MAX_WALK_FILES = 2000
MAX_GLOB_MATCHES = 200
MAX_LISTED = 10

_SPLIT = re.compile(r"[\s\"'`;&|()<>=,]+")
_STRIP = "\"'`;&|()<>,"
_NOT_TRUSTABLE = re.compile(r"[;&|`<>\n]|\$\(")
_PYTHON = re.compile(r"(?:^|[\\/])(?:python3?|py)(?:\.exe)?$", re.I)
_GITBASH_DRIVE = re.compile(r"^/([A-Za-z])/(.*)$")
_CD_TARGET = re.compile(r"\b(?:cd|pushd)\s+(\"[^\"]*\"|'[^']*'|[^\s;&|]+)")
_RECURSIVE_READER = re.compile(
    r"\b(?:rg|ag|ack|findstr|Select-String|xargs)\b"
    r"|\bgrep\b[^\n|;&]*\s(?:-[A-Za-z]*[rR]|--recursive)"
    r"|-exec\b|-Recurse\b|\bdir\s+/s\b")


# --------------------------------------------------------------------- output

def log_invocation(tool_name: str, decision: str, n_blocked: int = 0) -> None:
    """Content-free audit line. Proves the hook fires; never records a path."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(STATE_DIR / "guard.log", "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\t%d\n" % (
                datetime.datetime.now().isoformat(timespec="seconds"),
                tool_name or "-", decision, n_blocked))
    except OSError:
        pass


def emit(decision: str, reason: str) -> None:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


# ---------------------------------------------------------------- path finding

def to_native(raw: str) -> str:
    """Git Bash spells C:\\x as /c/x; Windows Python would read that as C:\\c\\x."""
    m = _GITBASH_DRIVE.match(raw)
    return "%s:/%s" % (m.group(1).upper(), m.group(2)) if m else raw


def _full(raw: str) -> Path | None:
    try:
        p = Path(to_native(raw)).expanduser()
        return p if p.is_absolute() else Path.cwd() / p
    except (OSError, ValueError, RuntimeError):
        return None


def expand(raw: str):
    """Existing files a token could name: the literal path first, then as a glob."""
    full = _full(raw)
    if full is None:
        return []
    try:
        if full.is_file():
            return [full.resolve()]
        if full.is_dir():
            return []
    except OSError:
        return []
    if not any(ch in raw for ch in "*?["):
        return []
    try:
        hits = glob.glob(str(full), recursive=True)[:MAX_GLOB_MATCHES]
    except (OSError, ValueError, re.error):
        return []
    return [Path(h).resolve() for h in hits if Path(h).is_file()]


def as_dir(raw: str) -> Path | None:
    full = _full(raw)
    try:
        return full.resolve() if full is not None and full.is_dir() else None
    except OSError:
        return None


def walk(root: Path):
    n = 0
    for p in root.rglob("*"):
        try:
            parts = p.relative_to(root).parts
        except ValueError:
            continue
        if any(part in SKIP_DIRS for part in parts):
            continue
        if p.is_file():
            yield p.resolve()
            n += 1
            if n >= MAX_WALK_FILES:
                return


def bash_tokens(command: str, pathlike_only: bool = True):
    tokens = set()
    try:
        tokens.update(shlex.split(command, posix=True))
    except ValueError:
        pass
    # shlex keeps "B;" and "x)" as single tokens, so also split on punctuation.
    tokens.update(_SPLIT.split(command))
    cd_targets = {t.strip("\"'") for t in _CD_TARGET.findall(command)}
    out = []
    for tok in tokens:
        tok = tok.strip().strip(_STRIP)
        if not tok or tok in cd_targets or tok.startswith(("-", "+", "$")):
            continue
        if pathlike_only and "/" not in tok and "\\" not in tok and "." not in tok:
            continue
        out.append(tok)
    return out


def _strings(node):
    if isinstance(node, str):
        if len(node) < 1024:
            yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(k)
            yield from _strings(v)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _strings(v)


def targets(tool_name: str, tool_input: dict, roots):
    """Every file this call could read. Over-inclusive by design."""
    files, dirs = [], []
    if tool_name == "Read":
        files += expand(tool_input.get("file_path") or "")
    elif tool_name == "Grep":
        raw = tool_input.get("path") or str(Path.cwd())
        d = as_dir(raw)
        if d is not None:
            dirs.append(d)
        else:
            files += expand(raw)
    elif tool_name in SHELL_TOOLS:
        command = tool_input.get(SHELL_TOOLS[tool_name]) or ""
        for tok in bash_tokens(command):
            files += expand(tok)
        if _RECURSIVE_READER.search(command):
            # A directory argument is often a bare word ("grep -rn foo src"), so
            # every token is a candidate here, not just the path-looking ones.
            for tok in bash_tokens(command, pathlike_only=False):
                d = as_dir(tok)
                if d is not None:
                    dirs.append(d)
            if not dirs:
                dirs.append(Path.cwd().resolve())
    else:
        # Artifact publishes file_path and every entry of files; SendUserFile ships
        # a file to another device. Any string in the input naming a file counts.
        for value in _strings(tool_input):
            files += expand(value)
    for d in dirs:
        if within(d, roots):
            files += list(walk(d))
    seen, out = set(), []
    for f in files:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def scan_roots(config):
    """Where patient data can live: the project, the configured raw capture
    directories, and Downloads (where a capture lands before it is moved).

    Outside these the guard neither scans nor walks. System logs and temp files
    carry timestamps the date rules flag, and twins of them are only litter.
    """
    roots = [deid.PROJECT_ROOT.resolve(), DOWNLOADS]
    for raw_dir in (config.get("raw_dirs") or {}):
        try:
            roots.append(Path(raw_dir).expanduser().resolve())
        except OSError:
            pass
    return roots


def within(path: Path, roots) -> bool:
    return any(path == r or r in path.parents for r in roots)


def trusted_command(command: str) -> bool:
    if _NOT_TRUSTABLE.search(command):
        return False
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return False
    if len(tokens) < 2 or not _PYTHON.search(tokens[0]):
        return False
    script = expand(tokens[1])
    return bool(script) and script[0] in TRUSTED_SCRIPTS


def is_guard_state(path: Path) -> bool:
    try:
        return path.parent == STATE_DIR.resolve() and path.name in STATE_FILES
    except OSError:
        return False


# ----------------------------------------------------------------------- cache

def _cache_file() -> Path:
    return STATE_DIR / "scan_cache.json"


def _rules_stamp() -> str:
    st = (HERE / "deid.py").stat()
    return "%d:%d" % (st.st_mtime_ns, st.st_size)


def load_cache() -> dict:
    stamp = _rules_stamp()
    try:
        data = json.loads(_cache_file().read_text(encoding="utf-8"))
        if data.get("_rules") == stamp:
            return data
    except (OSError, ValueError):
        pass
    return {"_rules": stamp}


def save_cache(cache: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_file().write_text(json.dumps(cache), encoding="utf-8")
    except OSError:
        pass


# ------------------------------------------------------------------------ main

def main() -> int:
    payload = json.load(sys.stdin)
    tool_name = payload.get("tool_name", "")
    if tool_name not in CONTENT_TOOLS:
        log_invocation(tool_name, "ignored")
        return 0

    tool_input = payload.get("tool_input") or {}
    if tool_name == "Bash" and trusted_command(tool_input.get("command") or ""):
        log_invocation(tool_name, "trusted")
        return 0

    config = deid.load_config()
    roots = scan_roots(config)
    twin_roots = [roots[0]] + roots[2:]
    cache, dirty = load_cache(), False
    rules_mtime = (HERE / "deid.py").stat().st_mtime_ns
    engine = None
    blocked, oversized = [], 0

    for path in targets(tool_name, tool_input, roots):
        if not within(path, roots) or is_guard_state(path) or not deid.is_scannable(path, config):
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        if st.st_size > deid.MAX_SCAN_BYTES:
            oversized += 1
            continue

        key = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:32]
        sig = "%d:%d" % (st.st_mtime_ns, st.st_size)
        text = None
        hit = cache.get(key)
        if hit and hit[0] == sig:
            counts = hit[1]
        else:
            if engine is None:
                engine = deid.Deidentifier(deid.load_salt(), None, config)
            text = deid.read_text(path)
            counts = dict(engine.scan(text))
            cache[key] = [sig, counts]
            dirty = True
        if not counts:
            continue

        if engine is None:
            engine = deid.Deidentifier(deid.load_salt(), None, config)
        if not within(path, twin_roots):
            # Downloads: block it, but copy nothing into the project.
            blocked.append((path, None, counts))
            continue
        twin = deid.twin_path(path, config)
        # The filename is content too -- same rule as `deid.py apply`.
        safe_name, _ = engine.apply(twin.name)
        twin = twin.with_name(safe_name)
        stale = (not twin.exists()
                 or twin.stat().st_mtime_ns < max(st.st_mtime_ns, rules_mtime))
        if stale:
            if text is None:
                text = deid.read_text(path)
            clean, _ = engine.apply(text)
            twin.parent.mkdir(parents=True, exist_ok=True)
            twin.write_text(clean, encoding="utf-8")
        blocked.append((path, twin, counts))

    if dirty:
        save_cache(cache)

    if not blocked and not oversized:
        log_invocation(tool_name, "allow")
        return 0

    lines = []
    if blocked:
        lines.append(
            "Blocked: %d file(s) contain patient identifiers. A de-identified twin "
            "is kept for each -- read that instead." % len(blocked)
        )
        for path, twin, counts in blocked[:MAX_LISTED]:
            detail = ", ".join("%s=%d" % (k, v) for k, v in sorted(counts.items()))
            safe_src, _ = engine.apply(_rel(path))
            lines.append("  %s" % safe_src)
            if twin is None:
                lines.append("    -> no twin written; move it into a raw_dirs folder and run "
                             "tools/deid.py apply   (%s)" % detail)
            else:
                lines.append("    -> %s   (%s)" % (_rel(twin), detail))
        if len(blocked) > MAX_LISTED:
            lines.append("  ... and %d more" % (len(blocked) - MAX_LISTED))
        lines.append(
            "To process raw files, run tools/deid.py or tools/deid_verify.py on its "
            "own (no &&, pipes or redirects) -- those invocations are trusted. For a "
            "false positive, add a glob to \"exclude\" in deid.config.json."
        )
    if oversized:
        lines.append("%d file(s) over %d bytes could not be scanned -- unverified."
                     % (oversized, deid.MAX_SCAN_BYTES))
    decision = "deny" if blocked else "ask"
    log_invocation(tool_name, decision, len(blocked))
    emit(decision, "\n".join(lines))
    return 0


def _rel(path: Path) -> str:
    try:
        return path.relative_to(deid.PROJECT_ROOT).as_posix()
    except ValueError:
        return str(path)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log_invocation("?", "error")
        emit("ask", "phi_guard.py failed, so this call is UNVERIFIED for patient "
                    "identifiers:\n" + traceback.format_exc(limit=3))
        sys.exit(0)
