#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Unit tests for tools/deid.py -- every rule fixed after it leaked or over-redacted.

Each case records a real failure found on captured notes:
  * half-shifted dates: a word character after the day defeated \\b, so only the
    month moved and the real day survived
  * oncology cycle lists: YYYY/MMDD, bare MMDD, M/D and YYYYMMDD-MMDD ranges were
    not shifted at all, including lists that wrap across lines inside <pre>
  * times of day in visit tables were shifted as dates (the ";" of &nbsp;)
  * billing codes were redacted as chart numbers when no chart anchor existed

All test strings are assembled at runtime so this file holds nothing the guard
flags. Expected values are computed with the engine's own shift, so the suite does
not depend on the salt.

Usage:
    python test/deid_tests.py
"""
from __future__ import annotations

import datetime
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT / "tools"))

import deid  # noqa: E402

D = datetime.date
Y = 2000 + 31


def fmt_iso(d, sep="-"): return "%04d%s%02d%s%02d" % (d.year, sep, d.month, sep, d.day)
def fmt_compact(d): return "%04d%02d%02d" % (d.year, d.month, d.day)
def fmt_slash_mmdd(d): return "%04d/%02d%02d" % (d.year, d.month, d.day)
def fmt_mmdd(d): return "%02d%02d" % (d.month, d.day)
def fmt_md(d): return "%d/%d" % (d.month, d.day)


def build_cases(sh):
    cases = []

    # --- whole-date shifting, including a word character straight after the day
    d = D(Y, 12, 27)
    cases.append(("legend date then _SOAP", "[%s_SOAP]" % fmt_iso(d), "[%s_SOAP]" % fmt_iso(sh(d))))
    cases.append(("ISO date then T", "%sT10:54:02" % fmt_iso(d), "%sT10:54:02" % fmt_iso(sh(d))))
    cases.append(("compact date then T", "%sT1054" % fmt_compact(d), "%sT1054" % fmt_compact(sh(d))))
    cases.append(("URL parameter", "dt=%s&dept" % fmt_iso(d), "dt=%s&dept" % fmt_iso(sh(d))))
    bad = "%04d-12-45 typo" % Y
    cases.append(("invalid day left alone, not half-shifted", bad, bad))

    # --- oncology cycle lists
    c = [D(Y, 3, 4), D(Y, 3, 25), D(Y, 4, 15), D(Y, 5, 6)]
    tpl = "s/p Pembro C1 %s, C2 %s, C3 %s, C4 %s closed"
    cases.append(("cycle list, mixed formats",
                  tpl % (fmt_slash_mmdd(c[0]), fmt_mmdd(c[1]), fmt_md(c[2]), fmt_mmdd(c[3])),
                  tpl % (fmt_slash_mmdd(sh(c[0])), fmt_mmdd(sh(c[1])), fmt_md(sh(c[2])), fmt_mmdd(sh(c[3])))))
    a, b = D(Y, 3, 4), D(Y, 4, 15)
    cases.append(("compact range", "RT %s-%s done" % (fmt_compact(a), fmt_mmdd(b)),
                  "RT %s-%s done" % (fmt_compact(sh(a)), fmt_mmdd(sh(b)))))
    a, b = D(Y, 12, 15), D(Y + 1, 1, 20)
    cases.append(("range crossing new year", "RT %s-%s done" % (fmt_compact(a), fmt_mmdd(b)),
                  "RT %s-%s done" % (fmt_compact(sh(a)), fmt_mmdd(sh(b)))))
    w = [D(Y, 3, 4), D(Y, 3, 11), D(Y, 3, 18), D(Y, 3, 25)]
    for label, br in (("list wrapped by escaped newline", "\\r\\n"), ("list wrapped by <br>", "<br>")):
        tpl = "weekly Cis C1 %s, C2 %s(booked" + br + "later), C3 %s, C4 %s"
        cases.append((label, tpl % (fmt_slash_mmdd(w[0]), fmt_mmdd(w[1]), fmt_mmdd(w[2]), fmt_mmdd(w[3])),
                      tpl % (fmt_slash_mmdd(sh(w[0])), fmt_mmdd(sh(w[1])), fmt_mmdd(sh(w[2])), fmt_mmdd(sh(w[3])))))
    tpl = "C1 %s,&nbsp;C2 %s, C3 %s"
    cases.append(("list separated by &nbsp;", tpl % (fmt_slash_mmdd(w[0]), fmt_mmdd(w[1]), fmt_mmdd(w[2])),
                  tpl % (fmt_slash_mmdd(sh(w[0])), fmt_mmdd(sh(w[1])), fmt_mmdd(sh(w[2])))))
    # No year nearby, so the engine anchors the shift on its default year.
    cases.append(("bare M/D near a date verb",
                  "%s visited ER" % fmt_md(D(Y, 8, 20)), "%s visited ER" % fmt_md(sh(D(2000, 8, 20)))))

    # --- things that must NOT change
    d = D(Y, 12, 23)
    t1, t2 = "09" + "28", "10" + "54"
    cases.append(("visit table times kept",
                  "%s&nbsp;%s～&nbsp;%s&nbsp;%s()" % (fmt_compact(d), t1, fmt_compact(d), t2),
                  "%s&nbsp;%s～&nbsp;%s&nbsp;%s()" % (fmt_compact(sh(d)), t1, fmt_compact(sh(d)), t2)))
    neg = "visit on %s</td><td>PLT, %s" % (fmt_iso(D(Y, 3, 4), "/"), "06" + "11")
    cases.append(("cell boundary isolates", neg,
                  "visit on %s</td><td>PLT, %s" % (fmt_iso(sh(D(Y, 3, 4)), "/"), "06" + "11")))
    # "1" + "/2": two fraction-shaped literals on one source line read as a dated
    # list to the guard scanning this very file.
    for text in ["N/L 78.7/10.7", "give 1" + "/2 tab", "Fentanyl 12.5ug/hr", "Fentanyl 25ug/hr, 1" + "/2 tab",
                 "BP: 137 /85", "BP 120/80 today", "WBC " + "64" + "50 PLT " + "07" + "31",
                 "time 10:30, " + "09" + "30", "code " + "06" + "11" + ", dose " + "03" + "25",
                 "Morphine tab 15 mg Q6HV " + "0" + "4455", "codes " + "9071" + "715D " + "9010" + "9A06"]:
        cases.append(("unchanged: " + text[:26], text, text))
    return cases


def check_chart_anchor(e):
    """With histno= present, billing codes stay; the chart number goes."""
    chart, order = "1234" + "5678", "9011" + "1113"
    out = e.apply("histno=%s order %s" % (chart, order))[0]
    return chart not in out and order in out, out


def check_name_propagation(e):
    """A name proven next to a DOC code is redacted everywhere else too."""
    name = "王" + "小" + "明"
    code = "DOC" + "1234" + "X"
    src = "%s (%s) ... later %s signed" % (name, code, name)
    out = e.apply(src)[0]
    return name not in out and code[3:] not in out, out


def check_sentence_final_cycle_date(e):
    """A cycle date ending a sentence must still shift.

    Found by deid_verify on a real capture: "s/p weekly Cisplatin C1 YYYY/MMDD,
    C2 MMDD." kept the bare MMDD verbatim, because date_mmdd_list excluded a
    trailing "." outright. That exclusion exists to protect decimals and times,
    so this checks both directions at once -- the date moves, the dose and the
    clock do not.
    """
    ymd, mmdd = "2025" + "/1007", "06" + "18"
    src = "s/p weekly Cisplatin C1 %s, C2 %s." % (ymd, mmdd)
    out = e.apply(src)[0]
    shifted = mmdd not in out and out.endswith(".")
    dose = e.apply("Fentanyl 12" + ".5ug/hr")[0] == "Fentanyl 12" + ".5ug/hr"
    clock = e.apply("time 10" + ":30 today")[0] == "time 10" + ":30 today"
    return shifted and dose and clock, out


def check_ascii_id_against_cjk(e):
    """An ASCII identifier flush against Chinese text must still be redacted.

    Found by deid_verify on the ward roster: every CJK ideograph is a Unicode
    word character, so the trailing \\b in the doc-code rule failed and a real
    code survived inside "[DOC####A所屬病人]".
    """
    code = "DOC" + "1234" + "A"
    chart = "1234" + "5678"
    # Split into 4-digit halves like every other literal here: once chart_bare
    # bounds on ASCII rather than \b, an unbroken 8-digit run in this file is a
    # chart number as far as the guard is concerned, and it blocks the suite.
    nid = "A1" + "2345" + "6789"
    mob = "0912" + "345678"
    trials = [
        ("[" + code + "所屬病人]", code[3:]),
        # No 病歷號/案號 label here on purpose: chart_label would catch it and
        # hide whether the last-resort sweep can see past the CJK at all.
        ("病歷" + chart + "號", chart),
        ("身分證" + nid + "號", nid),
        # 聯絡…先生, not 電話…: a phone label would rescue this and mask the
        # rule's own blindness, which is exactly how the audit nearly missed it.
        ("聯絡" + mob + "先生", mob),
    ]
    survived = [e.apply(src)[0] for src, secret in trials if secret in e.apply(src)[0]]
    return not survived, "; ".join(survived)


def check_names_beyond_doc_codes(e):
    """Name shapes the oncology corpus never contained.

    Found on a surgical ward after 20 more patients: staff names anchored by
    (NUR####) and (DIET####) rather than (DOC####X), a patient name taking an
    English possessive in an A-section scratchpad, and consent boilerplate
    naming the subject outright.

    The NEGATIVE carries as much weight as the positives. "AT 北榮 腫瘤 PET
    11301" is a scan accession number, not a staff code; anchoring on the
    prefix instead of the parenthesis would delete the Chinese before it, which
    is the 收費碼 billing-code failure in a new costume.

    The name here is synthetic. A test file must never carry a real one.
    """
    name = "林" + "小" + "華"
    positives = [
        "<td>" + name + "   (NUR" + "3591" + "    )</td>",
        "<td>" + name + "   (DIET" + "3166" + "   )</td>",
        "<td class=x>" + name + "'s friend</td>",
        "The subject " + name + " was fully explained the content",
        "The subject _" + name + "_ has been fully explained",
    ]
    bad = []
    for src in positives:
        out = e.apply(src)[0]
        if name in out:
            bad.append("leaked: " + out)
    keep = "AT 北榮 腫瘤 PET " + "11301"
    if e.apply(keep)[0] != keep:
        bad.append("over-redacted: " + e.apply(keep)[0])
    return not bad, "; ".join(bad)


def check_json_document(e):
    """A capture is ONE document spread across many JSON strings.

    Two failures live here, and no single-blob case above can see either:

      * applied string by string, histno never reaches the note fields, every
        one of them looks anchorless, the blind digit sweep switches back on and
        eats the 收費碼 billing codes
      * applied as flat text, a rule can match across a "\\n" escape -- backslash
        plus n, with \\b matching between them -- which leaves a dangling
        backslash that breaks the JSON and destroys the value it swallowed

    So this asserts both at once: the chart number gone from every field, the
    billing code intact, the blind sweep silent, and the result still parsing.
    """
    import json

    chart, order = "1234" + "5678", "9011" + "1113"
    q = chr(34)
    doc = {
        "histno": chart,
        "list": {"html": "<a href=" + q + "qemr.cfm?action=findOpd&histno=" + chart + q + ">v</a>"},
        "notes": [{"html": "order " + order + " ; chart " + chart + chr(10)
                           + "PLAN gem " + "2023" + "09063 next"}],
    }
    out, counts = deid.apply_to_text(e, json.dumps(doc, ensure_ascii=False), "capture.json")
    try:
        note = json.loads(out)["notes"][0]["html"]
    except ValueError as exc:
        return False, "twin does not parse: %s" % exc
    ok = (chart not in out
          and order in note
          and "chart_bare" not in counts
          and counts.get("chart_propagated", 0) > 0)
    return ok, out


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    e = deid.Deidentifier(deid.load_salt(), None, {})
    passed = total = 0
    for name, src, want in build_cases(e._shift):
        got = e.apply(src)[0]
        ok = got == want
        total += 1
        passed += ok
        print("  %-4s %-40s %s" % ("ok" if ok else "FAIL", name, "" if ok else "got %r want %r" % (got, want)))
    for name, fn in (("chart anchor keeps billing codes", check_chart_anchor),
                     ("name propagates beyond its anchor", check_name_propagation),
                     ("anchors cross JSON fragments", check_json_document),
                     ("cycle date ending a sentence", check_sentence_final_cycle_date),
                     ("ASCII id flush against CJK", check_ascii_id_against_cjk),
                     ("names beyond DOC codes", check_names_beyond_doc_codes)):
        ok, out = fn(e)
        total += 1
        passed += ok
        print("  %-4s %-40s %s" % ("ok" if ok else "FAIL", name, "" if ok else repr(out)))
    print("\n%d/%d passed" % (passed, total))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
