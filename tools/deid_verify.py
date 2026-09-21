#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Prove a de-identified twin carries none of the identifiers in its raw source.

deid.py can only report what its rules matched, which says nothing about what they
missed. This works from the other side: pull every identifier that can be PROVEN
from the raw file -- chart and case numbers from histno=/caseno=, doctor names and
codes from the visit list, the patient name from a page title or banner, national
IDs, mobile numbers, and date formats the shifting rules once missed -- and count
how many survive in the twin's content and filename.

Output is categories and counts only, never a raw value, so it is safe to run
against raw captures inside the guarded session. A category with no anchor in the
raw file is reported as such rather than as a pass: absence of evidence is not
evidence of absence, and that matters most for the patient name.

Usage:
    python tools/deid_verify.py RAW [RAW ...]          # twin located as deid.py apply names it
    python tools/deid_verify.py RAW --twin TWIN
    python tools/deid_verify.py RAW --show-leaks       # context from the TWIN for date survivors
    python tools/deid_verify.py RAW --explain RULE     # where RULE fired, de-identified context
Exit status 1 if any identifier survived.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deid  # noqa: E402

CJK = deid.CJK

# (category, pattern, match mode). Mode decides how survival is tested:
#   digits -- the value with no digit either side
#   code   -- the value with no digit before and no letter or digit after
#   text   -- plain substring (CJK names have no word boundaries)
PROBES = [
    ("chart", re.compile(r"(?i)\b(?:histno|hisid|pidno|chart_?no)\s*[=:]\s*(\d{4,10})\b"), "digits"),
    ("chart", re.compile(r"(?:病歷號碼|病歷號)\s*[:：]?\s*(\d{4,10})"), "digits"),
    ("case_no", re.compile(r"(?i)\b(?:caseno|adicase)\s*[=:]\s*(\d{4,10})\b"), "digits"),
    ("doc_code", re.compile(r"\bDOC(\d{4}[A-Z])\b"), "code"),
    ("doc_name", re.compile(r"([" + CJK + r"]{2,4})(?=\s*\(\s*DOC\d{4}[A-Z])"), "text"),
    ("patient_name", re.compile(r"<title>\s*([" + CJK + r"]{2,4})(?=&nbsp;\s*\d)"), "text"),
    ("patient_name", re.compile(r"<span style=\"font-weight:\s*500;\s*padding:\s*2px 6px\">\s*"
                                r"([" + CJK + r"]{2,4})\s*</span>"), "text"),
    ("national_id", re.compile(r"\b([A-Za-z][12]\d{8})\b"), "code"),
    ("mobile", re.compile(r"\b(09\d{2}-?\d{3}-?\d{3})\b"), "code"),
    # Date formats the shifting rules once missed. The cycle-list probe keeps its
    # "Cn " lead-in so a correctly shifted date no longer matches verbatim.
    ("loose_date", re.compile(
        r"(?<!\d)(\d{4}/(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?!\d)"), "text"),
    ("loose_date", re.compile(
        r"(?<!\d)(\d{8}-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?!\d)"), "text"),
    ("loose_date", re.compile(
        r"(\bC\d{1,2}(?:-\d{1,2})?\s+(?:(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])"
        r"|\d{1,2}/\d{1,2}))(?![\d/.])"), "text"),
]
CATEGORIES = ["chart", "case_no", "doc_code", "doc_name", "patient_name",
              "national_id", "mobile", "loose_date"]
# Where a missing anchor is worth a warning rather than a shrug.
MUST_ANCHOR = {"chart", "patient_name"}
# --show-leaks may print context only for these. A surviving name or number is
# PHI in its own right, so its context is never printed, twin or not.
SHOWABLE = {"loose_date"}
MAX_SHOWN = 20


def strings_of(path: Path):
    """All text in a file. JSON is walked so escaped HTML is matched as HTML."""
    text = deid.read_text(path)
    try:
        data = json.loads(text)
    except ValueError:
        return [text], {}
    out, fields = [], {}

    def walk(node, key=None):
        if isinstance(node, dict):
            for k, v in node.items():
                out.append(k)
                walk(v, k)
        elif isinstance(node, list):
            for v in node:
                walk(v, key)
        elif isinstance(node, str):
            out.append(node)
            if key:
                fields.setdefault(key, []).append(node)

    walk(data)
    return out, fields


def collect(strings, fields):
    found = {}
    for cat, rx, mode in PROBES:
        for s in strings:
            for m in rx.finditer(s):
                value = m.group(1).strip()
                if mode == "text" and value in deid.NAME_STOPWORDS:
                    continue
                found.setdefault(cat, {})[value] = mode
    for value in fields.get("histno", []):
        if re.fullmatch(r"\d{4,10}", value):
            found.setdefault("chart", {})[value] = "digits"
    return found


def _pattern(value: str, mode: str):
    if mode == "text":
        return re.compile(re.escape(value))
    after = r"(?!\d)" if mode == "digits" else r"(?![0-9A-Za-z])"
    return re.compile(r"(?<!\d)" + re.escape(value) + after)


def survives(value: str, mode: str, hay: str) -> bool:
    return _pattern(value, mode).search(hay) is not None


def context(hay: str, a: int, b: int, left: int = 60, right: int = 30) -> str:
    ctx = hay[max(0, a - left):a] + ">>>" + hay[a:b] + "<<<" + hay[b:b + right]
    ctx = ctx.replace("\\r", "").replace("\\n", " | ").replace("\r", "").replace("\n", " | ")
    ctx = re.sub(r"<[^<>]{0,300}>", " ", ctx)
    return re.sub(r"\s+", " ", ctx).strip()


def default_twin(raw: Path, engine) -> Path:
    twin = deid.twin_path(raw)
    safe_name, _ = engine.apply(twin.name)
    return twin.with_name(safe_name)


def masked(name: str) -> str:
    return re.sub(r"\d{6,}", lambda m: "#" * len(m.group(0)), name)


def verify(raw: Path, twin: Path, show_leaks: bool = False) -> bool:
    print("RAW   %s" % masked(raw.name))
    if not twin.is_file():
        print("TWIN  missing -- run tools/deid.py apply on the raw file first")
        return False
    try:
        rel = twin.resolve().relative_to(deid.PROJECT_ROOT).as_posix()
    except ValueError:
        rel = twin.name
    print("TWIN  %s" % rel)

    secrets = collect(*strings_of(raw))
    hay = "\n".join(strings_of(twin)[0])
    ok = True
    print("  %-13s %6s %9s %9s" % ("category", "found", "in text", "in name"))
    for cat in CATEGORIES:
        values = secrets.get(cat, {})
        if not values:
            note = ("UNVERIFIED -- no provable anchor in raw"
                    if cat in MUST_ANCHOR else "none in raw")
            print("  %-13s %6d %9s %9s   %s" % (cat, 0, "-", "-", note))
            continue
        in_text = sum(1 for v, m in values.items() if survives(v, m, hay))
        in_name = sum(1 for v, m in values.items() if survives(v, m, twin.name))
        flag = "" if in_text == 0 and in_name == 0 else "   *** LEAK ***"
        ok = ok and not flag
        print("  %-13s %6d %9d %9d%s" % (cat, len(values), in_text, in_name, flag))
        if show_leaks and in_text:
            if cat not in SHOWABLE:
                print("      (context withheld: a surviving %s is itself an identifier)" % cat)
                continue
            shown = 0
            for v, m in values.items():
                for hit in _pattern(v, m).finditer(hay):
                    if shown >= MAX_SHOWN:
                        break
                    print("      leak: " + context(hay, hit.start(), hit.end()))
                    shown += 1
    print("PASS" if ok else "FAIL")
    return ok


def explain(raw: Path, engine, rule: str, limit: int) -> int:
    """Show where one rule fired, using only DE-IDENTIFIED text around each hit.

    For tuning rules and hunting false positives without ever printing raw input:
    the replacement is marked and its surroundings come from the output side.
    """
    text = deid.read_text(raw)
    pieces, pos, length, hits = [], 0, 0, []
    for start, end, _idx, rep, name in engine._collect(text):
        chunk = text[pos:start]
        pieces.append(chunk)
        length += len(chunk)
        if name == rule:
            hits.append((length, length + len(rep)))
        pieces.append(rep)
        length += len(rep)
        pos = end
    pieces.append(text[pos:])
    clean = "".join(pieces)

    print("RAW   %s   rule %s: %d hit(s)" % (masked(raw.name), rule, len(hits)))
    for a, b in hits[:limit]:
        print("  " + context(clean, a, b))
    if len(hits) > limit:
        print("  ... %d more" % (len(hits) - limit))
    return 0


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("raw", nargs="+")
    ap.add_argument("--twin", help="explicit twin path (only with a single RAW)")
    ap.add_argument("--show-leaks", action="store_true",
                    help="for date survivors, print context taken from the TWIN")
    ap.add_argument("--explain", metavar="RULE",
                    help="show where RULE fired, as de-identified context, instead of verifying")
    ap.add_argument("--limit", type=int, default=40, help="max hits shown by --explain")
    ap.add_argument("--summary", action="store_true",
                    help="print a tally and only the files that FAILED; verifying a "
                         "whole ward otherwise buries the one report that matters")
    args = ap.parse_args(argv)
    if args.twin and len(args.raw) != 1:
        ap.error("--twin needs exactly one RAW")

    engine = deid.Deidentifier(deid.load_salt(), None, deid.load_config())
    # Directories are expanded exactly as `deid.py apply` expands them: the guard
    # blocks listing a raw capture folder, so naming fifty files by hand is not
    # possible, and a verifier that cannot be pointed at a whole ward is a
    # verifier that quietly stops being run.
    targets, unscannable = deid.resolve_inputs(args.raw, engine.config)
    if not targets:
        print("nothing to verify")
        return 1
    if args.twin and len(targets) != 1:
        ap.error("--twin needs exactly one RAW")

    if args.explain:
        for raw in targets:
            explain(raw, engine, args.explain, args.limit)
        return 0

    if args.summary:
        # Fifty per-file tables push the one failing report out of reach, and the
        # obvious fix -- piping into grep -- voids the guard's trusted-invocation
        # exception. So the tool does the filtering itself.
        import contextlib
        import io as _io

        failures = []
        for raw in targets:
            twin = Path(args.twin) if args.twin else default_twin(raw, engine)
            buf = _io.StringIO()
            with contextlib.redirect_stdout(buf):
                ok = verify(raw, twin, args.show_leaks)
            if not ok:
                failures.append(buf.getvalue().rstrip())
        print("%d file(s) verified, %d FAILED" % (len(targets), len(failures)))
        for report in failures:
            print()
            print(report)
        for p in unscannable:
            print("skip %s" % deid.safe_label(engine, p))
        return 0 if not failures else 1

    all_ok = True
    for i, raw in enumerate(targets):
        if i:
            print()
        twin = Path(args.twin) if args.twin else default_twin(raw, engine)
        all_ok = verify(raw, twin, args.show_leaks) and all_ok
    for p in unscannable:
        print("skip %s" % deid.safe_label(engine, p))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
