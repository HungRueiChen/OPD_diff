#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Regression suite for tools/phi_guard.py. Prints decisions only, never content.

Self-contained: it builds a synthetic "dirty" file inside the project at runtime
(fake name and chart number, assembled from fragments so this source stays clean),
and removes it and its twin afterwards. No real patient data is needed.

Usage:
    python test/guard_tests.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
PY = sys.executable
PYB = "/" + PY[0].lower() + PY[2:].replace("\\", "/")  # Git Bash spelling of this python

SELFTEST_DIR = PROJECT / "test" / "_selftest"
DIRTY_REL = "test/_selftest/dirty.html"
DIRTY = PROJECT / DIRTY_REL
DIRTY_ABS = DIRTY.as_posix()
DIRTY_WIN = str(DIRTY)
DIRTY_GITBASH = "/" + DIRTY_ABS[0].lower() + DIRTY_ABS[2:]
TWIN_DIR = PROJECT / "deid" / "test" / "_selftest"
EXTERNAL = Path(tempfile.gettempdir()) / "opd_guard_selftest.log"


def setup():
    SELFTEST_DIR.mkdir(parents=True, exist_ok=True)
    chart = "1234" + "5678"
    name = "王" + "小" + "明"
    DIRTY.write_text("<title>" + name + "&nbsp;" + chart + "</title>\n"
                     "<a href='qemr.cfm?action=findOpd&histno=" + chart + "'>x</a>\n",
                     encoding="utf-8")
    # An ordinary log outside every scan root, with a timestamp the date rules flag.
    EXTERNAL.write_text("service started on " + "20" + "31-03-04" + " 10:00\n", encoding="utf-8")


def teardown():
    shutil.rmtree(SELFTEST_DIR, ignore_errors=True)
    shutil.rmtree(TWIN_DIR, ignore_errors=True)
    try:
        (PROJECT / "deid" / "test").rmdir()
    except OSError:
        pass
    EXTERNAL.unlink(missing_ok=True)


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


def ps(cmd):
    return {"tool_name": "PowerShell", "tool_input": {"command": cmd}}


def raw_glob():
    sys.path.insert(0, str(PROJECT / "tools"))
    import deid
    for raw_dir in (deid.load_config().get("raw_dirs") or {}):
        if any(Path(raw_dir).glob("*.json")):
            return Path(raw_dir).as_posix() + "/*.json"
    return None


def cases():
    out = [
        ("Read dirty file", {"tool_name": "Read", "tool_input": {"file_path": DIRTY_REL}}, "deny"),
        ("Read clean file", {"tool_name": "Read", "tool_input": {"file_path": "src/capture.js"}}, "allow"),
        ("Read its de-identified twin", {"tool_name": "Read", "tool_input": {"file_path": "deid/" + DIRTY_REL}}, "allow"),
        ("for-loop, path ends in ;", bash("for f in src/capture.js " + DIRTY_REL + '; do head -c 0 "$f"; done'), "deny"),
        ("quoted abs path then ;", bash('head -c 0 "' + DIRTY_ABS + '"; echo x'), "deny"),
        ("Git Bash /c/ path", bash("head -c 0 " + DIRTY_GITBASH), "deny"),
        ("glob", bash("cat test/_selftest/*.html"), "deny"),
        ("path inside python code", bash('python - <<EOF\nopen("' + DIRTY_REL + '").read()\nEOF'), "deny"),
        ("Grep on dirty dir", {"tool_name": "Grep", "tool_input": {"pattern": "x", "path": "test/_selftest"}}, "deny"),
        ("Grep on clean dir", {"tool_name": "Grep", "tool_input": {"pattern": "x", "path": "src"}}, "allow"),
        ("Grep with no path (project)", {"tool_name": "Grep", "tool_input": {"pattern": "x"}}, "deny"),
        ("grep -rn on clean dir", bash("grep -rn foo src"), "allow"),
        ("grep -rn on cwd", bash("grep -rn foo"), "deny"),
        ("rg on cwd", bash("rg foo"), "deny"),
        ("cd project then ls", bash('cd "' + PROJECT.as_posix() + '" && ls src'), "allow"),
        ("trusted deid.py alone", bash('"' + PYB + '" tools/deid.py scan ' + DIRTY_REL), "allow"),
        ("trusted verify alone", bash('"' + PYB + '" tools/deid_verify.py ' + DIRTY_REL), "allow"),
        ("deid.py chained with cat", bash('"' + PYB + '" tools/deid.py scan ' + DIRTY_REL + " && cat " + DIRTY_REL), "deny"),
        ("deid.py piped", bash('"' + PYB + '" tools/deid.py apply ' + DIRTY_REL + " --stdout | head"), "deny"),
        ("unrelated python -c", bash('python -c "print(1)"'), "allow"),
        ("PowerShell Get-Content dirty", ps('Get-Content "' + DIRTY_WIN + '" -TotalCount 1'), "deny"),
        ("PowerShell Get-Content clean", ps("Get-Content src\\capture.js -TotalCount 1"), "allow"),
        ("PowerShell recurse search", ps("Get-ChildItem -Recurse | Select-String foo"), "deny"),
        ("IDE executeCode opens dirty", {"tool_name": "mcp__ide__executeCode", "tool_input": {"code": 'open(r"' + DIRTY_WIN + '").read()'}}, "deny"),
        ("Artifact file_path dirty", {"tool_name": "Artifact", "tool_input": {"file_path": DIRTY_REL}}, "deny"),
        ("Artifact files map dirty", {"tool_name": "Artifact", "tool_input": {"file_path": "src/capture.js", "files": {"a.html": DIRTY_REL}}}, "deny"),
        ("Artifact clean", {"tool_name": "Artifact", "tool_input": {"file_path": "src/capture.js"}}, "allow"),
        ("SendUserFile dirty", {"tool_name": "SendUserFile", "tool_input": {"file_path": DIRTY_ABS}}, "deny"),
        ("external log outside scope", {"tool_name": "Read", "tool_input": {"file_path": str(EXTERNAL)}}, "allow"),
        ("recursive grep outside scope", bash("grep -rn foo " + Path(tempfile.gettempdir()).as_posix()), "allow"),
        ("non-content tool", {"tool_name": "Edit", "tool_input": {"file_path": DIRTY_REL}}, "allow"),
    ]
    glob = raw_glob()
    if glob:
        out.append(("raw capture dir outside project", bash("cat " + glob), "deny"))
    return out


def decide(payload, raw=None):
    data = raw if raw is not None else json.dumps(payload)
    r = subprocess.run([PY, "tools/phi_guard.py"], input=data.encode("utf-8"),
                       capture_output=True, cwd=str(PROJECT), timeout=180)
    out = r.stdout.decode("utf-8", "replace").strip()
    if not out:
        return "allow"
    try:
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"]
    except (ValueError, KeyError):
        return "unparseable"


def main() -> int:
    setup()
    fails = total = 0
    try:
        for name, payload, expected in cases() + [("malformed payload", None, "ask")]:
            got = decide(payload, raw="not json" if payload is None else None)
            ok = got == expected
            total += 1
            fails += not ok
            print("%-4s %-32s expected %-5s got %s" % ("ok" if ok else "FAIL", name, expected, got))
        litter = PROJECT / "deid" / "_external"
        if litter.exists() and any(litter.iterdir()):
            total += 1
            fails += 1
            print("FAIL deid/_external holds twins of files outside the project")
    finally:
        teardown()
    print("\n%d/%d passed" % (total - fails, total))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
