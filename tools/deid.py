#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""De-identify VGH HIS clinical text before it reaches an LLM context or leaves this machine.

Design notes that matter for the OPD diff tool:

* Pseudonyms are STABLE. The same chart number always maps to the same
  ``[[PT-xxxxxx]]``, so visits for one patient still link across files and a
  multi-visit diff keeps working on de-identified input.
* Dates are SHIFTED, not removed. Intervals between visits are the whole point of
  a diff, so a date becomes another real date offset by a fixed number of days.
  The offset is global by default (derived from the salt alone) so every file
  shifts by the same amount and cross-file comparisons stay coherent.
* Ages over 89 are capped at 90 (HIPAA safe-harbour aggregation).

The salt lives OUTSIDE the repo -- see ``_default_salt_path`` -- because it is the
only thing that makes the mapping reproducible. Losing it means new pseudonyms;
leaking it alongside de-identified text means the date shift can be undone.

This reduces risk; it is not a certified de-identification. Check it against your
hospital's own policy before sending output anywhere.

Usage:
    python tools/deid.py scan  PATH [PATH ...]   # exit 1 if identifiers found
    python tools/deid.py apply PATH [-o OUT | --in-place | --stdout]
"""
from __future__ import annotations

import argparse
import datetime
import fnmatch
import hashlib
import hmac
import json
import os
import re
import string
import sys
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEID_DIR = PROJECT_ROOT / "deid"
CONFIG_PATH = PROJECT_ROOT / "deid.config.json"

# Suffixes worth scanning as text. Anything else is treated as opaque.
TEXT_SUFFIXES = {
    ".txt", ".text", ".htm", ".html", ".json", ".csv", ".tsv", ".md", ".log",
    ".py", ".xml", ".yml", ".yaml", ".ini", ".cfg", ".sql", ".ipynb", ".srt",
    ".js", ".mjs", ".cjs", ".ts", ".css", ".jsonl", ".har",
}
MAX_SCAN_BYTES = 16 * 1024 * 1024

CJK = r"一-鿿"

# Rules whose matched value is a person's name. Whatever these find is redacted
# everywhere else in the same document, verbatim -- see Deidentifier._collect.
NAME_RULES = {"doc_name", "title_name", "header_name", "md_label", "md_dr",
              "pt_name_label", "name_possessive", "name_consent"}
# Rules that prove a chart number outright, so the blind digit sweep can stand down.
CHART_ANCHOR_RULES = {"chart_kv", "chart_label"}
_PROPAGATED_PRIORITY = 10_000

# Words that make a bare "8/20" a date rather than a ratio or a dose fraction.
_DATE_CONTEXT = re.compile(
    r"(?:\bon\b|\bsince\b|\bs/p\b|\bvisited\b|\badmitted\b|\bstarted?\b|"
    r"\bfrom\b|\buntil\b|\bER\b|\bOPD\b|於|自|至|起|入院|出院|回診|"
    r"(?:19|20)\d{2}[-/]\d{1,2})", re.I)

# Oncology notes write dated lists: a cycle label, the year once, then bare dates
# ("C1 YYYY/MMDD, C2 MMDD, C3 M/D"). A bare MMDD or M/D counts as a date only when
# it follows a list lead-in AND a real date already appears earlier on that line.
_LIST_LEAD = re.compile(r"(?:\bC\d{1,2}(?:-\d{1,2})?|[,，、;~]|\bto\b|-)\s*$", re.I)
_LINE_HAS_DATE = re.compile(
    r"(?<!\d)(?:19|20)\d{2}[-/]?\d{2}|(?<![\d./])\d{1,2}/\d{1,2}(?![\d./])")
_YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?=[-/.年]|\d{4}(?!\d)|(?!\d))")


_HARD_BREAK = re.compile(r"</?(?:td|tr|th|table|pre|fieldset|legend|p|div)\b", re.I)
_SOFT_BREAK = re.compile(r"\r\n|\n|\\r\\n|\\n|<br\s*/?>", re.I)
# An entity is not punctuation: the ";" of &nbsp; once passed for a list separator.
_ENTITY = re.compile(r"&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);")


def _line_before(s, pos, lines=2, limit=240):
    """Up to `lines` lines of text before pos, never crossing a cell or block tag.

    Notes are hard-wrapped at about 80 columns inside <pre>, so a dated list often
    continues on the next line. One line of context misses the continuation; two
    catch it without reaching into an unrelated cell. Captures keep HTML inside
    JSON, so escaped newlines count as line breaks too.
    """
    window = s[max(0, pos - limit):pos]
    last_hard = None
    for m in _HARD_BREAK.finditer(window):
        last_hard = m
    if last_hard is not None:
        close = window.find(">", last_hard.start())
        window = window[close + 1:] if close >= 0 else window[last_hard.end():]
    breaks = [m.end() for m in _SOFT_BREAK.finditer(window)]
    if len(breaks) >= lines:
        window = window[breaks[-lines]:]
    return _ENTITY.sub(" ", window)



def _year_hint(text):
    years = _YEAR.findall(text)
    return int(years[-1]) if years else None


# Words that follow a role label but are not names.
NAME_STOPWORDS = {
    "簽章", "姓名", "代碼", "欄位", "紀錄", "記錄", "查詢", "資料", "說明",
    "醫師", "主治", "住院", "報告", "護理", "無", "未填",
    "門診", "門診記錄", "清單", "記錄", "病歷", "摘要", "診斷",
}


def _default_salt_path() -> Path:
    base = os.environ.get("OPD_DEID_HOME")
    if base:
        return Path(base) / "deid_salt.key"
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "opd_diff" / "deid_salt.key"
    return Path.home() / ".opd_diff" / "deid_salt.key"


def load_salt(path=None) -> bytes:
    """Return the persistent salt, creating it on first use with 0600 perms."""
    p = Path(path) if path else _default_salt_path()
    if p.exists():
        data = p.read_bytes()
        if len(data) >= 16:
            return data
    p.parent.mkdir(parents=True, exist_ok=True)
    salt = os.urandom(32)
    p.write_bytes(salt)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return salt


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    return {}


def read_text(path: Path) -> str:
    """Read a HIS file. Taiwanese systems still emit cp950, so try that too."""
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp950", "big5hkscs"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1")


def _plausible_ymd(y: int, m: int, d: int) -> bool:
    if not 1900 <= y <= 2100:
        return False
    try:
        datetime.date(y, m, d)
    except ValueError:
        return False
    return True


def _plausible_date8(s: str) -> bool:
    return len(s) == 8 and _plausible_ymd(int(s[:4]), int(s[4:6]), int(s[6:8]))


class Rule:
    __slots__ = ("name", "regex", "group", "kind", "transform")

    def __init__(self, name, pattern, kind=None, group=1, flags=0, transform=None):
        self.name = name
        self.regex = re.compile(pattern, flags)
        self.group = group
        self.kind = kind
        self.transform = transform


class Deidentifier:
    def __init__(self, salt, patient=None, config=None):
        self.salt = salt
        self.config = config or {}
        self.date_offset = self._date_offset(patient)
        self.rules = self._build_rules()

    # ---------------------------------------------------------------- helpers

    def tag(self, kind: str, value: str) -> str:
        """Stable, letters-only pseudonym so no later rule can match inside it."""
        digest = hmac.new(self.salt, ("%s:%s" % (kind, value.strip())).encode("utf-8"),
                          hashlib.sha256).digest()
        code = "".join(string.ascii_lowercase[b % 26] for b in digest[:6])
        return "[[%s-%s]]" % (kind, code)

    def _date_offset(self, patient) -> int:
        key = ("date-offset:%s" % (patient or "global")).encode("utf-8")
        digest = hmac.new(self.salt, key, hashlib.sha256).digest()
        days = 180 + int.from_bytes(digest[:4], "big") % 400
        return -days if digest[4] & 1 else days

    def _shift(self, d: datetime.date) -> datetime.date:
        return d + datetime.timedelta(days=self.date_offset)

    # ------------------------------------------------------------ transforms

    def _t_date_ymd(self, m):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not _plausible_ymd(y, mo, d):
            return None
        nd = self._shift(datetime.date(y, mo, d))
        sep = "/" if "/" in m.group(0) else "-"
        return "%04d%s%02d%s%02d" % (nd.year, sep, nd.month, sep, nd.day)

    def _t_date_compact(self, m):
        s = m.group(1)
        if not _plausible_date8(s):
            return None
        nd = self._shift(datetime.date(int(s[:4]), int(s[4:6]), int(s[6:8])))
        return "%04d%02d%02d" % (nd.year, nd.month, nd.day)

    def _t_date_roc(self, m):
        """民國 year, e.g. 民國 113 年 9 月."""
        ry, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not 1 <= ry <= 199 or not _plausible_ymd(ry + 1911, mo, d):
            return None
        nd = self._shift(datetime.date(ry + 1911, mo, d))
        return "%03d/%02d/%02d" % (nd.year - 1911, nd.month, nd.day)

    def _t_date_ym(self, m):
        y, mo = int(m.group(1)), int(m.group(2))
        if not _plausible_ymd(y, mo, 15):
            return None
        nd = self._shift(datetime.date(y, mo, 15))
        sep = "/" if "/" in m.group(0) else "-"
        return "%04d%s%02d" % (nd.year, sep, nd.month)

    def _t_age(self, m):
        return "90" if int(m.group(1)) > 89 else None

    def _t_date_md(self, m):
        """Bare month/day with no year, as in "M/D visited ER".

        Safe harbour treats any date element finer than a year as an identifier,
        and leaving these unshifted also breaks interval arithmetic against the
        dates that DID shift. But M/D is shaped exactly like a ratio or a dose
        fraction, so only fire when nearby text looks like a date context.
        (Examples here avoid real digits: this file is scanned by its own rules.)
        """
        mo, day = int(m.group(1)), int(m.group(2))
        if not (1 <= mo <= 12 and 1 <= day <= 31):
            return None
        window = m.string[max(0, m.start() - 40):m.end() + 40]
        before = _line_before(m.string, m.start())
        in_list = bool(_LIST_LEAD.search(before) and _LINE_HAS_DATE.search(before))
        if not (in_list or _DATE_CONTEXT.search(window)):
            return None
        year = _year_hint(before) or _year_hint(window) or 2000
        if not _plausible_ymd(year, mo, day):
            return None
        nd = self._shift(datetime.date(year, mo, day))
        return "%d/%d" % (nd.month, nd.day)

    def _t_date_y_mmdd(self, m):
        """Year, slash, then MMDD run together: YYYY/MMDD."""
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not _plausible_ymd(y, mo, d):
            return None
        nd = self._shift(datetime.date(y, mo, d))
        return "%04d/%02d%02d" % (nd.year, nd.month, nd.day)

    def _t_date_compact_range(self, m):
        """A compact start date with a bare MMDD end: YYYYMMDD-MMDD."""
        s, e = m.group(1), m.group(2)
        if not _plausible_date8(s):
            return None
        y = int(s[:4])
        start = datetime.date(y, int(s[4:6]), int(s[6:8]))
        try:
            end = datetime.date(y, int(e[:2]), int(e[2:]))
            if end < start:
                end = datetime.date(y + 1, int(e[:2]), int(e[2:]))
        except ValueError:
            return None
        ns, ne = self._shift(start), self._shift(end)
        return "%04d%02d%02d-%02d%02d" % (ns.year, ns.month, ns.day, ne.month, ne.day)

    def _t_date_mmdd_list(self, m):
        """Bare MMDD inside a dated list, gated by _LIST_LEAD and _LINE_HAS_DATE."""
        mo, day = int(m.group(1)), int(m.group(2))
        before = _line_before(m.string, m.start())
        if not (_LIST_LEAD.search(before) and _LINE_HAS_DATE.search(before)):
            return None
        if re.search(r"(?<!\d)\d{8}\s*$", before):
            return None  # HHMM straight after a compact date is a time of day
        year = _year_hint(before) or 2000
        if not _plausible_ymd(year, mo, day):
            return None
        nd = self._shift(datetime.date(year, mo, day))
        return "%02d%02d" % (nd.month, nd.day)

    def _t_chart_bare(self, m):
        s = m.group(1)
        if len(s) == 8 and _plausible_date8(s):
            return None
        return self.tag("PT", s)

    def _t_name(self, kind):
        def inner(m):
            name = m.group(1).strip()
            if not name or name in NAME_STOPWORDS:
                return None
            return self.tag(kind, name)
        return inner

    # ----------------------------------------------------------------- rules

    def _build_rules(self):
        t_name_md = self._t_name("MD")
        t_name_pt = self._t_name("PT")
        secret_assign = (
            r"(?i)\b(?:password|passwd|api_key|apikey|token|secret)\s*=\s*"
            r"[\"']([^\"']{4,})[\"']"
        )
        return [
            # Credentials first -- these must never survive.
            Rule("secret_assign", secret_assign, kind="SECRET"),
            Rule("secret_sk", r"\b(sk-[A-Za-z0-9_\-]{16,})\b", kind="SECRET"),

            # Direct identifiers.
            # (?<!\\) keeps this off the letter of an escape sequence: in raw
            # file text "\n" is backslash + n, \b matches between them, and n
            # followed by a 9-digit run looks exactly like a national ID. Such a
            # match corrupts the file AND destroys the value it swallowed. The
            # letter class stays [A-Za-z]: narrowing it to [A-Z] would fix this
            # corruption by missing real IDs, which is the wrong trade.
            Rule("national_id",
                 r"(?<!\\)(?<![0-9A-Za-z_])([A-Za-z][12]\d{8})(?![0-9A-Za-z_])",
                 kind="ID"),
            Rule("chart_kv",
                 r"(?i)\b(?:histno|caseno|hisid|adistno|adicase|pidno|chart_?no|patid)"
                 r"\s*[=:]\s*(\d{4,10})\b",
                 kind="PT"),
            Rule("chart_label",
                 r"(?:病歷號碼|病歷號|住院號|案號)\s*[:：]?\s*(\d{4,10})", kind="PT"),
            # \b is the wrong boundary for an ASCII identifier sitting in Chinese
            # text: 所 and every other CJK ideograph is a Unicode word character,
            # so the trailing \b FAILS in "[DOC nnnnA 所屬病人]" and a real code
            # survived de-identification in the ward roster. Bound on ASCII word
            # characters instead -- which is all this code is made of -- so the
            # rule still refuses to match inside a longer alphanumeric run.
            Rule("employee_id",
                 r"(?<![0-9A-Za-z_])(?:DOC)?(\d{4}[A-Z])(?![0-9A-Za-z_])", kind="MD"),

            # Contact details.
            Rule("phone_label",
                 r"(?:PHS|電話|分機|手機|Tel|TEL)\s*[:：]?\s*([0-9#\-()]{3,20})", kind="PHONE"),
            # Must stand on its own: an audit found this rule blind beside CJK
            # and only *appearing* to work because phone_label happened to catch
            # the same number via a nearby 電話. Beside any other Chinese word
            # there is no label to fall back on.
            Rule("phone_mobile",
                 r"(?<![0-9A-Za-z_])(09\d{2}-?\d{3}-?\d{3})(?![0-9A-Za-z_])",
                 kind="PHONE"),

            # Names. Structural anchors first: in the qemr visit list the label
            # lives in a separate <th>, so nothing sits next to the name except
            # the markup around it. These two are the highest-confidence hits in
            # the whole ruleset, and whatever they learn is propagated verbatim
            # across the document by _collect (see NAME_RULES).
            # The PARENTHESIS is the anchor, not the prefix. Oncology only ever
            # produced (DOC nnnnA); a surgical ward adds (NUR nnnn) and
            # (DIET nnnn) in the same padded-cell shape, and a future service
            # will add more. (Digits are written as n here on purpose: a literal
            # four-digit run followed by a capital is the employee_id shape, and
            # this file is scanned by its own rules.)
            #
            # Bare codes are deliberately NOT anchored. "AT 北榮 ... PET nnnnn"
            # is a scan accession number, and the Han run before it is a place or
            # a clinical term. Anchoring on the prefix alone would start deleting
            # Chinese clinical text -- the 收費碼 billing-code failure again.
            Rule("doc_name",
                 r"([" + CJK + r"]{2,4})(?=\s*\(\s*[A-Z]{2,10}\s*\d{3,6}[A-Z]?\s*\))",
                 transform=t_name_md),
            # A Han run taking an English possessive is a person: clinical terms
            # do not take "'s". Found as "<name>'s friend" in an A-section
            # scratchpad, where no structural anchor exists at all and the name
            # survived de-identification into 14 copy-forward notes.
            Rule("name_possessive",
                 r"([" + CJK + r"]{2,4})(?=[’']s\b)", kind="PT"),
            # Consent boilerplate names the patient outright:
            #   "The subject <name> was fully explained ..."
            #   "The subject _<name>_ has been fully explained ..."
            Rule("name_consent",
                 r"(?:[Tt]he\s+subject\s*_?\s*)([" + CJK + r"]{2,4})", kind="PT"),
            # The document title is "<name>&nbsp;<chart number> …". Requiring the
            # chart number is what separates it from a nested fragment title such
            # as 門診記錄, which is a page label, not a person.
            Rule("title_name",
                 r"<title>\s*([" + CJK + r"]{2,4})(?=&nbsp;\s*\d)",
                 transform=t_name_pt),
            # The patient banner in the full qemr frame. The optional backslash
            # lets it match inside a capture, where the HTML is a JSON string.
            Rule("header_name",
                 r"<span style=\?\"font-weight:\s*500;\s*padding:\s*2px 6px\?\">\s*"
                 r"([" + CJK + r"]{2,4})\s*</span>",
                 transform=t_name_pt),

            # Then labelled positions -- a bare CJK bigram is far more
            # often a clinical term than a person.
            Rule("md_label",
                 r"(?:主治醫師|住院醫師|實習醫師|報告醫師|護理師|醫師)\s*[:：]?\s*"
                 r"([" + CJK + r"]{2,4})",
                 transform=t_name_md),
            Rule("md_dr",
                 r"\bDr\.?\s*([" + CJK + r"]{1,4}|[A-Z][a-zA-Z]{1,15})\b",
                 transform=t_name_md),
            Rule("pt_name_label",
                 r"(?:病人姓名|患者姓名|姓名|病人)\s*[:：]\s*([" + CJK + r"]{2,4})",
                 transform=t_name_pt),

            # Location.
            Rule("ward_bed", r"\b(\d{2,4}[A-Z]?-\d{1,2})\s*床", kind="WARD"),
            Rule("ward_label",
                 r"(?:病房|床號|病室)\s*[:：]?\s*([0-9A-Za-z\-]{2,10})", kind="WARD"),
            Rule("address",
                 r"([" + CJK + r"]{2,3}(?:縣|市)[" + CJK + r"]{1,4}(?:區|鄉|鎮)"
                 r"[^\s，。,]{0,30}?(?:路|街|大道)[^\s，。,]{0,20}?號)",
                 kind="ADDR"),

            # Dates -- shifted, so they stay usable. Order matters: the full
            # forms claim their span before the year-month form sees it.
            # Digit lookarounds, not \b. "_SOAP" or "T16" straight after the day is a
            # word character, which defeated \b and left the date HALF-shifted: the
            # year-month rule moved the month and kept the real day.
            Rule("date_ymd", r"(?<!\d)(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?!\d)",
                 group=0, transform=self._t_date_ymd),
            Rule("date_compact", r"(?<!\d)(\d{8})(?!\d)", group=0,
                 transform=self._t_date_compact),
            Rule("date_y_mmdd", r"(?<!\d)(\d{4})/(\d{2})(\d{2})(?!\d)",
                 group=0, transform=self._t_date_y_mmdd),
            Rule("date_compact_range", r"(?<!\d)(\d{8})-(\d{4})(?!\d)",
                 group=0, transform=self._t_date_compact_range),
            # The trailing exclusion rejects "." and ":" only when a DIGIT
            # follows. Excluding them outright is what protected "12.5ug/hr" and
            # "10:30" -- but it also rejected a cycle date ending a sentence, and
            # "C2 0618." survived de-identification in a real capture. A decimal
            # or a time always has a digit after the separator; a full stop at
            # the end of a clause does not.
            Rule("date_mmdd_list",
                 r"(?<![\d/.:A-Za-z])(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])"
                 r"(?![\d/A-Za-z])(?![.:]\d)",
                 group=0, transform=self._t_date_mmdd_list),
            Rule("date_roc", r"(?<![\d/])(\d{2,3})/(\d{1,2})/(\d{1,2})(?![\d/])",
                 group=0, transform=self._t_date_roc),
            # Never the prefix of a longer date: if date_ymd declined an invalid
            # day, shifting only the month would manufacture a fake date.
            Rule("date_ym", r"(?<!\d)(\d{4})[/-](\d{1,2})(?!\d)(?![/-]\d)", group=0,
                 transform=self._t_date_ym),

            Rule("date_md", r"(?<![\d./])(\d{1,2})/(\d{1,2})(?![\d./])",
                 group=0, transform=self._t_date_md),

            Rule("age_over_89",
                 r"\b(\d{2,3})\s*-?\s*(?:year[s]?[\s-]*old|y/o|yo|歲)\b",
                 flags=re.I, transform=self._t_age),

            # Last resort: a bare 7-8 digit run that is not a date. Chart numbers
            # in this HIS are 8 digits, so this errs towards over-redaction.
            # ASCII boundaries, not \b: a CJK ideograph is a Unicode word
            # character, so \b fails and "病歷nnnnnnnn號" -- which is just how a
            # Chinese note writes a chart number -- was invisible to this sweep.
            Rule("chart_bare", r"(?<![0-9A-Za-z_])(\d{7,8})(?![0-9A-Za-z_])",
                 transform=self._t_chart_bare),
        ]

    # ------------------------------------------------------------------ core

    def learn(self, text: str):
        """Anchors provable in this text: names, and chart numbers.

        Exposed so a caller that processes one document as many fragments -- a
        JSON capture, where histno sits in one field and the notes in others --
        can gather anchors across all of them first and then apply with the
        union. Anchor-then-propagate is a DOCUMENT-level mechanism; run per
        fragment it silently degrades to no anchoring at all.
        """
        learned, charts = {}, {}
        for start, end, _idx, rep, name in self._collect_once(text):
            literal = text[start:end]
            if name in NAME_RULES and len(literal) >= 2:
                learned[literal] = rep
            elif name in CHART_ANCHOR_RULES:
                charts[literal] = rep
        return learned, charts

    def _collect(self, text: str, seed_learned=None, seed_charts=None):
        """All non-overlapping replacements, plus propagated name occurrences.

        A name is usually identifiable in only one or two places in a document --
        the <title>, or the cell next to a DOC code. Everywhere else it appears as
        a bare CJK run with nothing to anchor on. So: find it where it is provable,
        then redact every verbatim occurrence of that exact string. Anchor once,
        propagate everywhere.
        """
        chosen = self._collect_once(text)
        learned = {}
        charts = {}
        for start, end, _idx, rep, name in chosen:
            literal = text[start:end]
            if name in NAME_RULES and len(literal) >= 2:
                learned[literal] = rep
            elif name in CHART_ANCHOR_RULES:
                charts[literal] = rep

        # Anchors proven elsewhere in the same DOCUMENT count here too. A JSON
        # capture keeps histno in one field and the note HTML in others; applied
        # string by string, every note looks anchorless, the blind digit sweep
        # switches back on, and it destroys the 收費碼 billing codes that
        # CHART_ANCHOR_RULES exists precisely to protect.
        if seed_learned:
            for literal, rep in seed_learned.items():
                learned.setdefault(literal, rep)
        if seed_charts:
            for literal, rep in seed_charts.items():
                charts.setdefault(literal, rep)

        # A chart number is provable whenever the document carries histno=… (every
        # captured page does). Once it is known, the blind 7-8 digit sweep is not
        # just unnecessary but harmful: in an OPD note those numbers are 收費碼
        # billing and order codes, and redacting them destroys the orders lane.
        # Keep the sweep only for fragments with no anchor to learn from.
        if charts:
            chosen = [c for c in chosen if c[4] != "chart_bare"]

        if not learned and not charts:
            return chosen

        extra = []
        for literal, rep in learned.items():
            for m in re.finditer(re.escape(literal), text):
                extra.append((m.start(), m.end(), _PROPAGATED_PRIORITY, rep,
                              "name_propagated"))
        for literal, rep in charts.items():
            for m in re.finditer(r"\b" + re.escape(literal) + r"\b", text):
                extra.append((m.start(), m.end(), _PROPAGATED_PRIORITY, rep,
                              "chart_propagated"))
        return self._resolve(chosen + extra)

    def _collect_once(self, text: str):
        """All non-overlapping replacements, earliest-then-longest-then-priority."""
        spans = []
        for idx, rule in enumerate(self.rules):
            for m in rule.regex.finditer(text):
                start, end = m.span(rule.group)
                if start < 0 or start == end:
                    continue
                if rule.transform:
                    rep = rule.transform(m)
                else:
                    rep = self.tag(rule.kind, m.group(rule.group))
                if rep is None:
                    continue
                spans.append((start, end, idx, rep, rule.name))
        return self._resolve(spans)

    @staticmethod
    def _resolve(spans):
        spans.sort(key=lambda s: (s[0], -(s[1] - s[0]), s[2]))
        chosen, last_end = [], 0
        for s in spans:
            if s[0] >= last_end:
                chosen.append(s)
                last_end = s[1]
        return chosen

    def scan(self, text: str) -> Counter:
        """Category counts only. Never returns the matched values themselves."""
        return Counter(s[4] for s in self._collect(text))

    def apply(self, text: str, seed_learned=None, seed_charts=None):
        chosen = self._collect(text, seed_learned, seed_charts)
        out, pos = [], 0
        for start, end, _idx, rep, _name in chosen:
            out.append(text[pos:start])
            out.append(rep)
            pos = end
        out.append(text[pos:])
        return "".join(out), Counter(s[4] for s in chosen)


# ----------------------------------------------------------------- file utils

def is_scannable(path: Path, config=None) -> bool:
    config = config or {}
    try:
        rp = path.resolve()
    except OSError:
        return False
    if not rp.is_file():
        return False
    if rp == DEID_DIR or DEID_DIR in rp.parents:
        return False
    if rp.suffix.lower() not in TEXT_SUFFIXES:
        return False
    rel = rp.as_posix()
    try:
        rel = rp.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        pass
    for pattern in config.get("exclude", []):
        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(rp.as_posix(), pattern):
            return False
    return True


def twin_path(path: Path, config=None) -> Path:
    """Where a file's de-identified twin lives.

    Project files mirror their relative path under deid/. Raw captures are kept
    OUTSIDE the project and outside OneDrive, so "raw_dirs" in deid.config.json
    maps each raw directory to a folder under deid/. Any other external file lands
    in deid/_external/ rather than colliding with project twins.
    """
    rp = path.resolve()
    try:
        return DEID_DIR / rp.relative_to(PROJECT_ROOT)
    except ValueError:
        pass
    config = load_config() if config is None else config
    for raw_dir, sub in (config.get("raw_dirs") or {}).items():
        try:
            return DEID_DIR / sub / rp.relative_to(Path(raw_dir).expanduser().resolve())
        except (ValueError, OSError):
            continue
    return DEID_DIR / "_external" / rp.name


def apply_to_text(engine, text, path=None):
    """De-identify a file's contents, structurally where the format demands it.

    JSON is not flat text. In the file, "\\n" is two characters -- a backslash and
    an "n" -- and a backslash is a non-word character, so \\b matches between
    them. A rule anchored on a leading letter therefore treats the escape's "n"
    as the start of its match: national_id ate the "n" of a newline plus the
    nine-digit run after it, which both left a dangling backslash (breaking the
    JSON) and destroyed the treatment date it swallowed.

    Decoding first means rules only ever see real string content, never the
    syntax holding it. Falls back to flat text for anything that is not JSON,
    including a .json file too broken to parse.
    """
    if path is not None and Path(path).suffix.lower() == ".json":
        try:
            data = json.loads(text)
        except ValueError:
            pass
        else:
            # Pass 1: learn anchors across EVERY string in the document before
            # rewriting any of it. Anchors are accumulated fragment by fragment
            # rather than from a concatenation: joining the strings would let a
            # rule match across a boundary and invent a chart anchor that is not
            # really there, which would switch the blind sweep off wrongly and
            # under-redact. Accumulating gives document-level semantics with no
            # boundary artefacts.
            learned, charts = {}, {}

            def gather(node):
                if isinstance(node, str):
                    found_names, found_charts = engine.learn(node)
                    learned.update(found_names)
                    charts.update(found_charts)
                elif isinstance(node, list):
                    for item in node:
                        gather(item)
                elif isinstance(node, dict):
                    for key, value in node.items():
                        if isinstance(key, str):
                            gather(key)
                        gather(value)

            gather(data)

            # Pass 2: rewrite, every fragment seeded with what the whole
            # document proved.
            counts = {}

            def walk(node):
                if isinstance(node, str):
                    cleaned, hits = engine.apply(node, learned, charts)
                    for name, n in hits.items():
                        counts[name] = counts.get(name, 0) + n
                    return cleaned
                if isinstance(node, list):
                    return [walk(x) for x in node]
                if isinstance(node, dict):
                    return dict((walk(k) if isinstance(k, str) else k, walk(v))
                                for k, v in node.items())
                return node

            return json.dumps(walk(data), ensure_ascii=False, indent=2), counts
    return engine.apply(text)


# ----------------------------------------------------------------------- CLI

def safe_label(deid, path) -> str:
    """A source path for printing, with the filename de-identified.

    The filename is content -- captures are named after a chart number -- and
    `scan` is a trusted command, so an unredacted path printed here would carry
    an identifier straight past the guard that blocks reading the file itself.
    Only the basename is rewritten, by the same rule `apply` uses for its twins,
    so a label matches the twin the guard would write.
    """
    p = Path(path)
    name, _ = deid.apply(p.name)
    return str(p.parent / name)


def resolve_inputs(paths, config):
    """Expand each argument to the scannable files under it.

    Directories are walked recursively, in sorted order. A ward's worth of
    captures is dozens of files, and naming them individually is impossible by
    design: the guard denies listing a raw directory, so nothing can enumerate
    it before de-identification except this tool.
    """
    files, skipped = [], []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            found = [c for c in sorted(p.rglob("*")) if is_scannable(c, config)]
            files.extend(found)
            if not found:
                skipped.append(p)
        elif is_scannable(p, config):
            files.append(p)
        else:
            skipped.append(p)
    return files, skipped


def cmd_scan(args) -> int:
    deid = Deidentifier(load_salt(args.salt), args.patient, load_config())
    files, unscannable = resolve_inputs(args.paths, deid.config)
    findings, clean = {}, []
    skipped = [safe_label(deid, p) for p in unscannable]
    for p in files:
        label = safe_label(deid, p)
        if p.stat().st_size > MAX_SCAN_BYTES:
            skipped.append("%s (too large)" % label)
            continue
        counts = deid.scan(read_text(p))
        if counts:
            findings[label] = dict(counts)
        else:
            clean.append(label)
    if args.json:
        print(json.dumps({"findings": findings, "clean": clean, "skipped": skipped},
                         ensure_ascii=False, indent=2))
    else:
        for label, counts in findings.items():
            detail = ", ".join("%s=%d" % (k, v) for k, v in sorted(counts.items()))
            print("PHI  %s  (%d matches: %s)" % (label, sum(counts.values()), detail))
        for label in clean:
            print("ok   %s" % label)
        for label in skipped:
            print("skip %s" % label)
    return 1 if findings else 0


def cmd_apply(args) -> int:
    deid = Deidentifier(load_salt(args.salt), args.patient, load_config())
    files, unscannable = resolve_inputs(args.paths, deid.config)
    if not files:
        # Say WHY. A bare "nothing to de-identify" is a dead end: the path may
        # not exist, may be an empty directory, or may hold only files whose
        # suffix is outside TEXT_SUFFIXES -- and the caller cannot tell which.
        print("nothing to de-identify")
        for p in unscannable:
            path = Path(p)
            if not path.exists():
                why = "does not exist"
            elif path.is_dir():
                why = "directory holds no scannable file"
            elif path.suffix.lower() not in TEXT_SUFFIXES:
                why = "suffix %r is not in TEXT_SUFFIXES" % (path.suffix or "(none)")
            else:
                why = "excluded by deid.config.json"
            print("  %s  (%s)" % (safe_label(deid, p), why))
        return 1
    if (args.output or args.stdout) and len(files) > 1:
        print("--output and --stdout take a single file; %d matched" % len(files))
        return 2

    written = 0
    for src in files:
        out_text, counts = apply_to_text(deid, read_text(src), src)
        if args.stdout:
            sys.stdout.write(out_text)
            continue
        if args.output:
            dest = Path(args.output)
        elif args.in_place:
            dest = src
        else:
            # The filename is content too: a capture is named after its chart number.
            dest = twin_path(src)
            safe_name, _ = deid.apply(dest.name)
            dest = dest.with_name(safe_name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(out_text, encoding="utf-8")
        detail = ", ".join("%s=%d" % (k, v) for k, v in sorted(counts.items())) or "none"
        print("wrote %s  (%d replacements: %s)" % (dest, sum(counts.values()), detail))
        written += 1
    for p in unscannable:
        print("skip %s" % safe_label(deid, p))
    if not args.stdout:
        print("%d file(s) de-identified" % written)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="De-identify VGH HIS clinical text.")
    ap.add_argument("--salt", help="override salt file path")
    ap.add_argument("--patient", help="chart number, for a per-patient date offset")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="report identifiers, exit 1 if any found")
    s.add_argument("paths", nargs="+")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_scan)

    a = sub.add_parser("apply", help="write a de-identified copy")
    a.add_argument("paths", nargs="+", help="files, or directories to walk")
    a.add_argument("-o", "--output")
    a.add_argument("--in-place", action="store_true")
    a.add_argument("--stdout", action="store_true")
    a.set_defaults(func=cmd_apply)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
