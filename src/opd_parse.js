/* OPD_diff -- parse VGH qemr OPD pages into plain records.
 *
 * Pure functions over the DOM: no network, no extension APIs, one exported
 * namespace (OPDParse). The same file runs pasted into DevTools, in an extension
 * content script or extension page, and in the offline headless harness.
 *
 * Everything is read from the DOM the browser builds, never by regex over raw
 * HTML. The note markup is malformed -- an unclosed <tr><td> before each table
 * body, stray <td> inside hidden rows -- and only the HTML parser's own repair
 * yields the tree the user actually sees.
 *
 * Anything unexpected is reported in `warnings` rather than dropped. In a diff
 * tool a section that silently parses as empty renders as "this finding
 * disappeared", which is a clinically misleading false change. Each warning has a
 * level: "warn" means the parser may have missed something, "info" means the note
 * itself is unusual (a P: section the clinician left blank, say).
 *
 * Target: Chrome/Edge 109 (the last Windows 7 releases).
 */
(function (root) {
  "use strict";

  const SECTION_HEADER = /^([SOAP])\s*[:：]\s*(?:主觀資料|客觀資料|診斷|治療計畫)?$/;
  const SOAP_LEGEND = /\[(\d{4}-\d{2}-\d{2})_SOAP\]/;

  // Diagnosis lines: an optional qualifier, a code, then free text.
  //   ICD-10-CM   C13.9, R13.19, U07.1, S72.001A        (visible rows)
  //   ICD-9-CM    148.9, V58.11, E878.8                  (hidden legacy rows)
  //               and dotless, as the HIS sometimes stores it: 1640 -> 164.0
  //   ICD-10-PCS  0UDB7ZX -- a procedure, not a diagnosis
  // A qualifier such as R/O must survive parsing: a rule-out shown as a confirmed
  // diagnosis on a disease timeline would be a clinical error.
  const QUALIFIER = /^(R\/O|S\/P|suspected|suspect|susp\.?|probable|possible|impression|imp\.?)\s+/i;
  const ICD10 = /^([A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)(?:\s+(.*))?$/;
  const ICD9 = /^((?:\d{3}|V\d{2}|E\d{3})(?:\.\d{1,2})?)(?:\s+(.*))?$/;
  const ICD9_DOTLESS = /^(\d{3}|V\d{2}|E\d{3})(\d{1,2})(?:\s+(.*))?$/;
  const PCS = /^((?=[0-9A-HJ-NP-Z]*\d)[0-9A-HJ-NP-Z]{7})(?:\s+(.*))?$/;
  const UNDEFINED_CODE_TEXT = /^undefined?\s+code$/i;

  // Boilerplate the HIS injects into free text. It is lifted into structured
  // fields and removed from diffText so it can never register as a clinical change.
  const TOCC = /【TOCC問診資料】[\s\S]*?【TOCC END】/g;
  const PAIN = /【疼痛評估：(\d{4}-\d{2}-\d{2})】\s*(\d{1,2})?\s*【疼痛評估】/g;
  const DUP_REASON = /＊(\d{4}-\d{2}-\d{2})重[複覆]用藥理由：([^＊]*)＊/g;

  const CLINIC_SESSION = /[－-]?(?:上午|下午|夜間|晚間)$/;

  const MED_COLUMNS = {
    "藥名": "name", "劑量": "dose", "單位": "unit", "途徑": "route",
    "天數": "days", "頻次": "frequency", "開始日期": "startDate", "備註": "remark",
  };
  const ORDER_COLUMNS = {
    "收費碼": "code", "檢驗名稱": "name", "檢體名稱": "specimen",
    "頻次": "frequency", "數量": "quantity", "是否自購": "selfPaid",
  };
  const DUP_COLUMNS = {
    "藥名": "name", "藥碼": "drugCode", "科別": "dept",
    "醫師代碼": "doctorCode", "處置": "action", "說明": "reason",
  };

  // ------------------------------------------------------------------ helpers

  function toDocument(input) {
    if (input && typeof input === "object" && input.nodeType === 9) return input;
    return new DOMParser().parseFromString(String(input || ""), "text/html");
  }

  function normalizeText(s) {
    return String(s || "")
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // <pre> blocks in P: mix literal newlines with <br>; both are line breaks.
  function textOf(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    return normalizeText(clone.textContent);
  }

  function isHidden(el) {
    return /display\s*:\s*none/i.test(el.getAttribute("style") || "");
  }

  // The HIS writes 0 or "-" for "not measured" ("BP: 0 /0", "BP: -/-").
  function measured(s) {
    if (s == null || s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  function legendText(fieldset) {
    const legend = fieldset.querySelector("legend");
    return legend ? normalizeText(legend.textContent) : "";
  }

  function paramsOf(href) {
    const out = {};
    if (!href) return out;
    try {
      new URL(href, "https://opd.invalid/").searchParams.forEach((v, k) => { out[k] = v; });
    } catch (e) { /* malformed href: leave params empty */ }
    return out;
  }

  function warn(list, code, extra) {
    list.push(Object.assign({ level: "warn", code }, extra));
  }

  function info(list, code, extra) {
    list.push(Object.assign({ level: "info", code }, extra));
  }

  // ---------------------------------------------------------------- visit list

  function parseDoctor(cell) {
    const m = /^(.*?)\s*\(\s*([^)\s]+)\s*\)\s*$/.exec(cell || "");
    return m ? { name: m[1].trim() || null, code: m[2] } : { name: (cell || "").trim() || null, code: null };
  }

  function parseDept(cell) {
    const m = /^\s*([0-9A-Z]{3})\s*\(\s*(.*?)\s*\)\s*$/.exec(cell || "");
    if (!m) return { code: null, name: (cell || "").trim() || null, clinic: null };
    return { code: m[1], name: m[2], clinic: m[2].replace(CLINIC_SESSION, "") };
  }

  function parseList(input) {
    const doc = toDocument(input);
    const warnings = [];
    const body = doc.querySelector("tbody#list");
    if (!body) {
      warn(warnings, "list-table-missing");
      return { visits: [], warnings };
    }
    const visits = [];
    Array.from(body.rows).forEach((tr, rowIndex) => {
      const cells = Array.from(tr.cells).map((td) => normalizeText(td.textContent));
      if (cells.length < 5) {
        warn(warnings, "list-row-short", { rowIndex, cells: cells.length });
        return;
      }
      const link = tr.querySelector('a[title="opddetail"]') || tr.cells[0].querySelector("a");
      const pdf = Array.from(tr.querySelectorAll("a"))
        .find((a) => /pdf\.cfm/i.test(a.getAttribute("href") || ""));
      const params = paramsOf(link && link.getAttribute("href"));
      const doctor = parseDoctor(cells[2]);
      const dept = parseDept(cells[3]);
      const visit = {
        rowIndex,
        date: cells[0] || params.dt || null,
        time: cells[1] || null,
        doctor,
        dept,
        icd10: cells[4] ? cells[4].split(/[,，\s]+/).filter(Boolean) : [],
        noteHref: link ? link.getAttribute("href") : null,
        pdfHref: pdf ? pdf.getAttribute("href") : null,
      };
      // (date, dept, doctor): one patient can attend several clinics in a day.
      visit.key = [visit.date, dept.code || params.dept || "", doctor.code || params.doc || ""].join("|");
      if (!link) warn(warnings, "list-row-no-note-link", { rowIndex });
      if (params.dt && visit.date && params.dt !== visit.date) {
        warn(warnings, "list-date-mismatch", { rowIndex });
      }
      visits.push(visit);
    });
    return { visits, warnings };
  }

  // --------------------------------------------------------------------- note

  function parseVitals(text) {
    const t = text.replace(/\s+/g, " ").trim();
    const bp = /BP\s*:\s*(\d+)?\s*\/\s*(\d+)?/.exec(t);
    const pick = (re) => { const m = re.exec(t); return m ? measured(m[1]) : null; };
    const v = {
      systolic: bp ? measured(bp[1]) : null,
      diastolic: bp ? measured(bp[2]) : null,
      pulse: pick(/PP\s*:\s*(\d+)/),
      height: pick(/BH\s*:\s*([\d.]+)/),
      weight: pick(/BW\s*:\s*([\d.]+)/),
      raw: t,
    };
    v.measured = [v.systolic, v.diastolic, v.pulse, v.height, v.weight].some((x) => x != null);
    return v;
  }

  function parseTable(fieldset, columns, label, warnings) {
    if (!fieldset) {
      warn(warnings, label + "-fieldset-missing");
      return [];
    }
    const rows = Array.from(fieldset.querySelectorAll("tr"));
    const headerAt = rows.findIndex((tr) =>
      Array.from(tr.cells).some((c) => columns[normalizeText(c.textContent)]));
    if (headerAt < 0) {
      warn(warnings, label + "-header-missing");
      return [];
    }
    const fields = Array.from(rows[headerAt].cells).map((c) => columns[normalizeText(c.textContent)] || null);
    const out = [];
    for (const tr of rows.slice(headerAt + 1)) {
      const cells = Array.from(tr.cells).map((c) => normalizeText(c.textContent));
      // The unclosed <tr><td> the HIS emits before each body repairs into an empty row.
      if (!cells.some(Boolean)) continue;
      if (cells.length !== fields.length) {
        warn(warnings, label + "-row-width", { expected: fields.length, got: cells.length });
      }
      const record = {};
      fields.forEach((field, i) => { if (field) record[field] = cells[i] == null ? "" : cells[i]; });
      out.push(record);
    }
    return out;
  }

  function emptySection() {
    return { text: "", diffText: "" };
  }

  function stripBoilerplate(text, note) {
    const t = String(text)
      .replace(TOCC, (m) => { if (!note.tocc) note.tocc = normalizeText(m); return ""; })
      .replace(PAIN, (m, date, score) => {
        note.pain.push({ date, score: score == null ? null : Number(score) });
        return "";
      })
      .replace(DUP_REASON, (m, date, reason) => {
        note.duplicateReasons.push({ date, reason: reason.trim() });
        return "";
      });
    return normalizeText(t);
  }

  function parseDiagnosisLine(line, hidden) {
    let rest = line;
    let qualifier = null;
    const q = QUALIFIER.exec(rest);
    if (q) {
      qualifier = q[1].toUpperCase().replace(/\.$/, "");
      rest = rest.slice(q[0].length);
    }
    const icd9 = () => {
      let m = ICD9.exec(rest);
      if (m) return { system: "icd9", code: m[1], text: m[2] || "" };
      m = ICD9_DOTLESS.exec(rest);
      return m ? { system: "icd9", code: m[1] + "." + m[2], text: m[3] || "", dotless: true } : null;
    };
    const icd10 = () => { const m = ICD10.exec(rest); return m ? { system: "icd10", code: m[1], text: m[2] || "" } : null; };
    const pcs = () => { const m = PCS.exec(rest); return m ? { system: "icd10pcs", code: m[1], text: m[2] || "" } : null; };
    // Hidden rows are the legacy ICD-9 list; visible rows are ICD-10. V and E codes
    // exist in both systems, so the row's visibility breaks the tie.
    const parsed = hidden ? (icd9() || icd10() || pcs()) : (icd10() || pcs() || icd9());
    if (!parsed) return null;
    parsed.text = parsed.text.trim();
    parsed.hidden = hidden;
    if (qualifier) parsed.qualifier = qualifier;
    if (UNDEFINED_CODE_TEXT.test(parsed.text)) parsed.undefinedCode = true;
    return parsed;
  }

  function parseDiagnoses(rows, note) {
    const d = note.diagnoses;
    for (const row of rows) {
      for (const raw of row.text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const parsed = parseDiagnosisLine(line, row.hidden);
        if (!parsed) d.unparsed.push(line);
        else if (parsed.system === "icd10") d.icd10.push(parsed);
        else if (parsed.system === "icd9") d.icd9.push(parsed);
        else d.procedures.push(parsed);
      }
    }
    // info, not warn: attendings use the A section as a scratchpad. Measured
    // across a 52-patient ward, all 297 of these came from 24 distinct lines,
    // every one confined to a single patient and none of them a diagnosis --
    // "MBC, BONE, LUNG", a relative's phone number, "TAVI protocol chest CT".
    // The parser is right to decline them; warning about correct behaviour 297
    // times only teaches the reader to ignore warnings.
    if (d.unparsed.length) info(note.warnings, "diagnosis-line-unparsed", { count: d.unparsed.length });
    // The visible ICD-10 list is what the clinician reads; ICD-9 rows are hidden legacy.
    const shown = d.icd10.filter((x) => !x.hidden);
    const lines = (shown.length ? shown : d.icd9)
      .map((x) => (x.qualifier ? x.qualifier + " " : "") + x.code + (x.text ? " " + x.text : ""));
    note.sections.A.text = lines.join("\n");
    note.sections.A.diffText = note.sections.A.text;
  }

  function parseNote(input) {
    const doc = toDocument(input);
    const warnings = [];
    const note = {
      soapDate: null,
      vitals: null,
      sections: { S: emptySection(), O: emptySection(), A: emptySection(), P: emptySection() },
      diagnoses: { icd10: [], icd9: [], procedures: [], unparsed: [] },
      pain: [],
      tocc: null,
      duplicateReasons: [],
      meds: [],
      orders: [],
      duplicateMeds: [],
      warnings,
    };

    const fieldsets = Array.from(doc.querySelectorAll("fieldset"));
    const byLegend = (re) => fieldsets.find((fs) => re.test(legendText(fs)));
    const soap = byLegend(/_SOAP\]/);

    if (!soap) {
      warn(warnings, "soap-fieldset-missing");
    } else {
      const m = SOAP_LEGEND.exec(legendText(soap));
      note.soapDate = m ? m[1] : null;
      if (!m) warn(warnings, "soap-legend-date-missing");

      const chunks = { S: [], O: [], P: [] };
      const diagnosisRows = [];
      const headers = new Set();
      let current = null;
      for (const tr of soap.querySelectorAll("tr")) {
        const text = textOf(tr);
        if (!text) continue;
        const header = SECTION_HEADER.exec(text);
        if (header) { current = header[1]; headers.add(current); continue; }
        if (!current) {
          if (/^BP\s*:/.test(text)) note.vitals = parseVitals(text);
          else warn(warnings, "row-before-first-section");
          continue;
        }
        if (current === "A") diagnosisRows.push({ text, hidden: isHidden(tr) });
        else chunks[current].push(text);
      }

      for (const k of ["S", "O", "P"]) {
        note.sections[k].text = normalizeText(chunks[k].join("\n"));
        note.sections[k].diffText = stripBoilerplate(note.sections[k].text, note);
      }
      parseDiagnoses(diagnosisRows, note);

      // A missing header means the parser lost its place; a present header with no
      // content means the clinician left the section blank. Only the first is a warning.
      for (const k of ["S", "O", "A", "P"]) {
        if (!headers.has(k)) warn(warnings, "section-missing", { section: k });
        else if (!note.sections[k].text) info(warnings, "section-blank", { section: k });
      }
      if (!note.vitals) warn(warnings, "vitals-row-missing");
      else if (!note.vitals.measured) info(warnings, "vitals-unmeasured");
    }

    note.meds = parseTable(byLegend(/用藥記錄/), MED_COLUMNS, "meds", warnings);
    note.orders = parseTable(byLegend(/門診醫囑/), ORDER_COLUMNS, "orders", warnings)
      .map((o) => Object.assign(o, { name: (o.name || "").replace(/^\*/, "").replace(/,\s*$/, "") }));
    note.duplicateMeds = parseTable(byLegend(/重[複覆]用藥/), DUP_COLUMNS, "duplicateMeds", warnings);
    return note;
  }

  const api = { parseList, parseNote, parseDiagnosisLine, normalizeText, textOf, version: 2 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
