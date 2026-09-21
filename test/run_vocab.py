#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Run test/vocab.html in a real headless browser and print its report.

Mines the de-identified fixtures for clinical language the course classifier does
not yet recognise, and ranks it by how many distinct patients use it. Output is a
candidate list for a clinician to accept or reject -- it changes no vocabulary by
itself.

Usage:
    python test/run_vocab.py [--edge] [--min 2]
--min drops terms seen in fewer than that many patients (default 1).
Exit status 1 if the browser is missing or the page reported an error.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlencode

PROJECT = Path(__file__).resolve().parent.parent
PAGE = PROJECT / "test" / "vocab.html"

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


def arg(flag: str, default: str) -> str:
    if flag in sys.argv and len(sys.argv) > sys.argv.index(flag) + 1:
        return sys.argv[sys.argv.index(flag) + 1]
    return default


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

    url = PAGE.as_uri() + "?" + urlencode({"min": arg("--min", "1")})
    profile = Path(os.environ.get("TEMP", ".")) / ("opd_diff_vocab_profile_" + kind)
    cmd = [str(browser), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions",
           "--allow-file-access-from-files", "--user-data-dir=" + str(profile),
           "--virtual-time-budget=60000", "--dump-dom", url]
    result = subprocess.run(cmd, capture_output=True, timeout=300)
    dom = result.stdout.decode("utf-8", "replace")

    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        print("no report element (exit %s)" % result.returncode)
        print(result.stderr.decode("utf-8", "replace")[-2000:])
        return 1
    report = (m.group(1)
              .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    print(report.strip())
    return 1 if report.strip().startswith("VOCAB ERROR") else 0


if __name__ == "__main__":
    sys.exit(main())
