#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Copy the shared modules into extension/lib/ so the extension can load them.

The extension deliberately lives in its own directory rather than at the repo
root, and this script is the reason why. A manifest at the root would package
EVERYTHING beside it -- including deid/fixtures/, which holds de-identified
captures for 72 real patients, and Autogenerate-admission/, which carries a
bundled chromedriver.exe. Neither belongs in a browser extension.

So: one source of truth in src/, copied in, and a hard refusal to copy from
anywhere else. Run after editing any module:

    python tools/build_extension.py

Exit status 1 if a source file is missing or a copy would escape the allowed
directories.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
SRC = PROJECT / "src"
DEST = PROJECT / "extension" / "lib"

# Named explicitly, not globbed. A glob would silently pick up anything dropped
# into src/ later, and "silently included in the shipped package" is the exact
# failure this script exists to prevent.
MODULES = [
    "opd_parse.js",
    "opd_lineage.js",
    "opd_course.js",
    "opd_stream.js",
    "opd_view.js",
    "opd_inline.js",
    "capture.js",
]

# Nothing from these may ever be copied, whatever else changes.
FORBIDDEN = ("deid", "Autogenerate-admission", "fixtures")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    missing = [m for m in MODULES if not (SRC / m).is_file()]
    if missing:
        print("missing in src/: %s" % ", ".join(missing))
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    for name in MODULES:
        source = (SRC / name).resolve()
        # Belt and braces: prove the source really is under src/ and not reached
        # through a symlink or a "..", before anything is written.
        if SRC.resolve() not in source.parents:
            print("refusing: %s resolves outside src/" % name)
            return 1
        if any(part in FORBIDDEN for part in source.parts):
            print("refusing: %s touches a forbidden directory" % name)
            return 1
        shutil.copyfile(source, DEST / name)
        print("copied %-18s %8d bytes" % (name, source.stat().st_size))

    print()
    print("%d module(s) in %s" % (len(MODULES), DEST.relative_to(PROJECT).as_posix()))
    print("Load unpacked from: %s" % (PROJECT / "extension"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
