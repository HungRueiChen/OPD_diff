#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Drive test/harness.html in a real headless browser and print its JSON report.

The parser depends on the browser's own HTML repair, so it is tested in Chrome and
Edge themselves rather than in a Python or Node approximation. A throwaway profile
under %TEMP% keeps the user's browser profile untouched.

Build the fixture first:  python tools/make_fixture_js.py
Usage:                    python test/run_harness.py [--edge] [--summary]
--summary aggregates the corpus and names only the cases that look wrong. The
full report carries evidence arrays per case, which is readable at two patients
and several thousand lines at fifty.
Exit status 1 if the browser is missing, the report is absent, or the harness errored.
"""
from __future__ import annotations

import html
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
HARNESS = (PROJECT / "test" / "harness.html").as_uri()

CANDIDATES = {
    "chrome": [r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
               r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
               r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"],
    "edge": [r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
             r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"],
}


def find_browser(kind: str):
    for candidate in CANDIDATES[kind]:
        path = Path(os.path.expandvars(candidate))
        if path.is_file():
            return path
    return None


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    kind = "edge" if "--edge" in sys.argv else "chrome"
    browser = find_browser(kind)
    if browser is None:
        print("%s not found in the usual install locations" % kind)
        return 1
    if not (PROJECT / "deid" / "fixtures" / "index.fixture.js").is_file():
        print("fixture missing -- run tools/make_fixture_js.py first")
        return 1

    profile = Path(tempfile.gettempdir()) / ("opd_diff_harness_profile_" + kind)
    cmd = [str(browser), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions",
           "--allow-file-access-from-files", "--user-data-dir=" + str(profile),
           # Both limits were set when the corpus was two patients. Fifty-two
           # cases each parse, build a lineage and build a course, so the old
           # 30s/240s pair truncates the run rather than failing it visibly.
           "--virtual-time-budget=120000", "--dump-dom",
           HARNESS + ("?summary=1" if "--summary" in sys.argv else "")]
    result = subprocess.run(cmd, capture_output=True, timeout=900)
    dom = result.stdout.decode("utf-8", "replace")
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        print("no report (exit %s)" % result.returncode)
        print(result.stderr.decode("utf-8", "replace")[-3000:])
        return 1
    report = html.unescape(m.group(1))
    print(report)
    return 1 if report.startswith("HARNESS ERROR") else 0


if __name__ == "__main__":
    sys.exit(main())
