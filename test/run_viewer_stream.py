#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Drive test/viewer_stream.html in a real headless browser and print its report.

The full-tab viewer is fed entirely by chrome.storage.local, which does not exist
outside an extension, so it was the one surface no offline harness could reach --
and it shipped once with a handover that never updated. This replaces storage
with an in-memory stub and replays what the content script does: publish the
visit list, drip the notes in, then mark the read done.

Build the fixture first:  python tools/make_fixture_js.py
Usage:                    python test/run_viewer_stream.py [--edge] [--case 51] [--gap 400]

--gap is the milliseconds between notes and defaults to 400, the fast end of the
real capture pacing. Do not lower it to speed the test up: below the rebuild
throttle every note lands in one window, the view jumps from empty straight to
finished, and the harness reports a pass for behaviour that is entirely static.
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
PAGE = PROJECT / "test" / "viewer_stream.html"

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

    url = "%s?case=%s&gap=%s" % (PAGE.as_uri(), arg("--case", "51"), arg("--gap", "400"))
    profile = Path(tempfile.gettempdir()) / ("opd_viewer_stream_profile_" + kind)
    cmd = [str(browser), "--headless=new", "--disable-gpu", "--no-first-run",
           "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
           "--allow-file-access-from-files", "--user-data-dir=" + str(profile),
           "--window-size=1680,1000",
           # The replay spends real time on one rebuild per throttle window, on
           # top of the drip itself, so this is generous on purpose.
           "--virtual-time-budget=300000", "--dump-dom", url]
    result = subprocess.run(cmd, capture_output=True, timeout=900)
    dom = result.stdout.decode("utf-8", "replace")

    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m:
        print("no report (exit %s)" % result.returncode)
        print(result.stderr.decode("utf-8", "replace")[-3000:])
        return 1
    report = html.unescape(m.group(1))
    print(report)
    return 0 if report.startswith("VIEWER OK") else 1


if __name__ == "__main__":
    sys.exit(main())
