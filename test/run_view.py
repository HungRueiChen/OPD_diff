#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render test/view.html in a real headless browser and save a screenshot.

The view depends on the browser's own layout and on Intl.Segmenter, so it is
checked in Chrome or Edge rather than in a simulated DOM. Screenshots are written
to the system temp directory, never into the project: they are pictures of
de-identified notes, but they are still derived from patient data.

Usage:
    python test/run_view.py [--edge] [--mode compare] [--case 1] [--size 1680,1400]
--size sets the headless window; the default is often shorter than a compare
column, which silently crops the lane rows off the bottom of the shot.
Exit status 1 if the browser is missing, the page reported an error, or no
screenshot was produced.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode

PROJECT = Path(__file__).resolve().parent.parent
PAGE = PROJECT / "test" / "view.html"

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
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv and len(sys.argv) > sys.argv.index(flag) + 1 else default


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

    fields = {"mode": arg("--mode", "course"), "case": arg("--case", "0")}
    if "--select" in sys.argv:
        fields["select"] = arg("--select", "")
    query = urlencode(fields)
    url = PAGE.as_uri() + "?" + query
    out = Path(tempfile.gettempdir()) / ("opd_view_%s_%s.png" % (kind, arg("--mode", "course")))
    if out.exists():
        out.unlink()
    profile = Path(tempfile.gettempdir()) / ("opd_diff_view_profile_" + kind)

    cmd = [str(browser), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
           "--allow-file-access-from-files", "--user-data-dir=" + str(profile),
           "--window-size=" + arg("--size", "1680,1000"), "--virtual-time-budget=30000",
           "--screenshot=" + str(out), "--dump-dom", url]
    result = subprocess.run(cmd, capture_output=True, timeout=240)
    dom = result.stdout.decode("utf-8", "replace")

    m = re.search(r'<pre id="status"[^>]*>(.*?)</pre>', dom, re.S)
    status = (m.group(1).strip() if m else "(no status element)")
    print(status[:2000])
    if not out.is_file():
        print("no screenshot written (exit %s)" % result.returncode)
        print(result.stderr.decode("utf-8", "replace")[-2000:])
        return 1
    print("screenshot %s (%d bytes)" % (out, out.stat().st_size))
    return 1 if status.startswith("VIEW ERROR") else 0


if __name__ == "__main__":
    sys.exit(main())
