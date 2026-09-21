#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Wrap de-identified captures as one script the offline harness can load.

Chrome refuses fetch() from one file:// URL to another, but it will load a
<script src>. So every twin in deid/fixtures/ is emitted into
deid/fixtures/index.fixture.js as an assignment into window.OPD_FIXTURES.

Reads de-identified twins only -- never a raw capture -- and writes inside deid/,
which stays gitignored and exempt from the guard like the twins themselves.

Usage:
    python tools/make_fixture_js.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "deid" / "fixtures"
OUT = FIXTURES / "index.fixture.js"


def main() -> int:
    # rglob, not glob: a ward's worth of captures tends to get filed into
    # subfolders, and a non-recursive glob would skip them in silence -- the
    # harness would then report on a handful of patients while looking complete.
    twins = sorted(FIXTURES.rglob("opd-capture-*.json"))
    if not twins:
        print("no twins in %s -- run tools/deid.py apply on a capture first" % FIXTURES)
        return 1
    parts = ["window.OPD_FIXTURES = {};"]
    unreadable = []
    for twin in twins:
        # A twin that will not parse is a de-identification bug upstream, not a
        # reason to lose every other patient. Record it and carry on, so the
        # corpus stays usable while the corruption is fixed at its source.
        try:
            data = json.loads(twin.read_text(encoding="utf-8"))
        except ValueError as exc:
            unreadable.append((twin.relative_to(FIXTURES).as_posix(), str(exc)))
            continue
        # Key by the path relative to deid/fixtures/, not the bare stem: for a
        # root-level twin the two are identical, but once subfolders are in play
        # two same-named captures would otherwise silently overwrite each other.
        key = twin.relative_to(FIXTURES).with_suffix("").as_posix()
        parts.append("window.OPD_FIXTURES[%s] = %s;" % (
            json.dumps(key), json.dumps(data, ensure_ascii=False)))
        print("wrapped %s  (%d notes)" % (key, len(data.get("notes", []))))
    # Say plainly how many patients are missing. A quietly shrunken corpus that
    # still looks complete is how you end up drawing ward-wide conclusions from
    # whatever happened to survive.
    for name, exc in unreadable:
        print("SKIPPED %s  (%s)" % (name, exc))
    if unreadable:
        print("%d of %d twin(s) did not parse and are NOT in the index"
              % (len(unreadable), len(twins)))
    OUT.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print("wrote %s  (%d bytes)" % (OUT.relative_to(ROOT).as_posix(), OUT.stat().st_size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
