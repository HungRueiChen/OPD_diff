#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Drive test/inline.html in a real headless browser and print its report.

Inline blame is the one feature that writes onto the HIS's own page, so it is
checked across every de-identified note: text unchanged while decorated, markup
restored exactly when removed, never coloured against another patient's record,
and honest while a read is still arriving.

Build the fixture first:  python tools/make_fixture_js.py
Usage:                    python test/run_inline.py [--edge] [--show 51,0]
--show case,note renders that one note decorated and saves a screenshot to the
system temp directory (a picture of de-identified text, still kept out of the
project).
Exit status 1 if the browser is missing, no report came back, or a check failed.
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
PAGE = PROJECT / "test" / "inline.html"

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

    url = PAGE.as_uri()
    extra = []
    if "--show" in sys.argv:
        which = sys.argv[sys.argv.index("--show") + 1]
        url += "?show=" + which
        shot = Path(tempfile.gettempdir()) / ("opd_inline_%s.png" % kind)
        if shot.exists():
            shot.unlink()
        extra = ["--window-size=900,1400", "--screenshot=" + str(shot)]

    profile = Path(tempfile.gettempdir()) / ("opd_inline_profile_" + kind)
    cmd = [str(browser), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
           "--allow-file-access-from-files", "--user-data-dir=" + str(profile),
           "--virtual-time-budget=300000"] + extra + ["--dump-dom", url]
    result = subprocess.run(cmd, capture_output=True, timeout=900)
    dom = result.stdout.decode("utf-8", "replace")
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        print("no report (exit %s)" % result.returncode)
        print(result.stderr.decode("utf-8", "replace")[-3000:])
        return 1
    report = html.unescape(m.group(1))
    print(report)
    if extra:
        print("screenshot %s" % shot)
    return 0 if report.startswith(("INLINE OK", "INLINE SHOW")) else 1


if __name__ == "__main__":
    sys.exit(main())
