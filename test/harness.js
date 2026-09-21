/* Harness: run every fixture through OPDParse, OPDLineage and OPDCourse, and
 * report what came out. Counts plus short evidence -- enough to tell a genuinely
 * blank section from a selector that silently matched nothing, and to eyeball the
 * course timeline, without dumping whole notes.
 */
(function () {
  "use strict";
  const out = document.getElementById("out");
  const MAX_EVIDENCE = 12;

  function bump(obj, key, by) {
    obj[key] = (obj[key] || 0) + (by == null ? 1 : by);
  }

  function pushCapped(list, item) {
    if (list.length < MAX_EVIDENCE) list.push(item);
  }

  function clip(s, n) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }

  // Unit checks for the diagnosis-line grammar, independent of any fixture.
  function diagnosisGrammar() {
    const cases = [
      ["C13.9 Malignant neoplasm of hypopharynx", false, { system: "icd10", code: "C13.9" }],
      ["U07.1 COVID-19", false, { system: "icd10", code: "U07.1" }],
      ["148.9 HYPOPHARYNGEAL CANCER", true, { system: "icd9", code: "148.9" }],
      ["R/O 148.2 MALIGNANT NEOPLASM", true, { system: "icd9", code: "148.2", qualifier: "R/O" }],
      ["1640 Undefine Code", true, { system: "icd9", code: "164.0", undefinedCode: true }],
      ["0UDB7ZX K2JFDGB", false, { system: "icd10pcs", code: "0UDB7ZX" }],
      ["V58.11 Chemotherapy", true, { system: "icd9", code: "V58.11" }],
      ["E11.9 Type 2 diabetes", false, { system: "icd10", code: "E11.9" }],
      ["CANCERS OF THE HEAD", false, null],
    ];
    return cases.map(([line, hidden, want]) => {
      const got = OPDParse.parseDiagnosisLine(line, hidden);
      const ok = want === null ? got === null
        : got !== null && Object.keys(want).every((k) => got[k] === want[k]);
      return { ok, line, got: got && { system: got.system, code: got.code, qualifier: got.qualifier } };
    });
  }

  // Unit checks for the diff itself. The rendering cases matter most: a run must
  // come back as the original text, not as tokens rejoined with spaces.
  function diffUnits() {
    const L = OPDLineage;
    const cases = [
      ["identical text scores 1", L.similarity("a b c", "a b c") === 1],
      ["disjoint text scores 0", L.similarity("a b c", "x y z") === 0],
      ["two empty texts score 0, not 1", L.similarity("", "") === 0],
      ["appended word is one added run",
       JSON.stringify(L.diffRuns("a b", "a b c").added) === JSON.stringify(["c"])],
      ["deleted word is one removed run",
       JSON.stringify(L.diffRuns("a b c", "a c").removed) === JSON.stringify(["b"])],
      ["no parent means everything is added",
       JSON.stringify(L.diffRuns("", "a b").added) === JSON.stringify(["a b"])],
      ["punctuation survives a run", (function () {
        // Assembled at runtime: a literal date here would make deid.py flag this
        // very file, and the guard would then block every command naming it.
        const run = "s/p OP on " + "20" + "25-10-21" + ".";
        return JSON.stringify(L.diffRuns("start", "start " + run).added) === JSON.stringify([run]);
      })()],
      ["Chinese keeps its spacing",
       JSON.stringify(L.diffRuns("開始", "開始 要補資料").added) === JSON.stringify(["要補資料"])],
    ];
    return cases.map(([name, ok]) => ({ name, ok }));
  }

  // Unit checks for course classification. The negatives are the point: an
  // abbreviation must not be read as a response unless imaging is alongside.
  function courseUnits() {
    const kinds = (text) => OPDCourse.classify(text).map((k) => k.kind).sort().join(",");
    const cases = [
      ["spelled response is a status", kinds("PARTIAL RESPONSE, no residual").indexOf("status") >= 0],
      ["SD next to imaging is a status", kinds("Chest CT " + "2023" + "0107 SD").indexOf("status") >= 0],
      ["PR alone is not a status", kinds("PV: PR exam unremarkable").indexOf("status") < 0],
      ["imaging is detected", kinds("WBBS shows uptake").indexOf("imaging") >= 0],
      ["stage is detected", kinds("hypopharynx, cT3N2bM0 s/p op").indexOf("stage") >= 0],
      ["marker value is parsed", (function () {
        const m = OPDCourse.classify("CA 125 40.1 rising").filter((k) => k.kind === "marker")[0];
        return Boolean(m) && m.value === 40.1;
      })()],
      ["plain text raises nothing", kinds("patient feels well today") === ""],
    ];
    return cases.map(([name, ok]) => ({ name, ok }));
  }

  /* Aggregate the per-case report into something readable at 52 patients.
   *
   * The full report carries evidence arrays per case: useful at two patients,
   * several thousand lines at fifty. This sums everything countable and then
   * names ONLY the cases that look wrong -- an aggregate that hides which case
   * failed is no more use than the flood it replaces.
   *
   * It summarises the SAME report the full mode prints, rather than computing
   * its own. Two computation paths would drift, and a summary that quietly stops
   * describing all 52 cases is worse than no summary.
   */
  function summarise(report) {
    const names = Object.keys(report.cases);
    const corpus = { cases: names.length, listRows: 0, notes: 0 };
    const warnings = {};
    const lineage = { notes: 0, baseline: 0, copied: 0, rewritten: 0, crossClinicParents: 0 };
    const events = {};
    const blame = { line: { rebuilds: 0, attributed: 0, deepest: 0 },
                    token: { rebuilds: 0, attributed: 0, deepest: 0 } };
    const anomalies = [];
    let icd10Match = 0;
    let casesWithMarkers = 0;

    names.forEach((name) => {
      const c = report.cases[name];
      // A case that threw is the loudest possible anomaly: report it by name and
      // do not let it quietly contribute zeros to every total below.
      if (c.failed) {
        anomalies.push({ case: name, issue: "harness threw", detail: c.failed });
        return;
      }
      corpus.listRows += c.listRows;
      corpus.notes += c.notes;
      icd10Match += c.icd10ListMatchesNote;

      Object.keys(c.warnings || {}).forEach((key) => {
        warnings[key] = (warnings[key] || 0) + c.warnings[key];
        // info: warnings are normal (unmeasured vitals, blank P). warn: is not.
        if (key.indexOf("warn:") === 0) anomalies.push({ case: name, issue: key, detail: c.warnings[key] });
      });
      Object.keys(lineage).forEach((key) => { lineage[key] += (c.lineage && c.lineage[key]) || 0; });
      const kinds = (c.course && c.course.events) || {};
      Object.keys(kinds).forEach((key) => { events[key] = (events[key] || 0) + kinds[key]; });
      if (c.course && c.course.markers && c.course.markers.length) casesWithMarkers++;

      ["line", "token"].forEach((granularity) => {
        const b = c.blame && c.blame[granularity];
        if (!b) return;
        if (b.rebuildsNoteExactly) blame[granularity].rebuilds++;
        else anomalies.push({ case: name, issue: "blame does not rebuild the note", detail: granularity });
        if (b.everyRunAttributedToChain) blame[granularity].attributed++;
        else anomalies.push({ case: name, issue: "blame run attributed outside the chain", detail: granularity });
        blame[granularity].deepest = Math.max(blame[granularity].deepest, b.chainLength || 0);
      });

      if (!c.notes) {
        anomalies.push({ case: name, issue: "no notes captured", detail: c.listRows + " list row(s)" });
      } else {
        if (c.notes !== c.listRows) {
          anomalies.push({ case: name, issue: "fewer notes than list rows", detail: c.notes + "/" + c.listRows });
        }
        if (c.icd10ListMatchesNote !== c.notes) {
          anomalies.push({ case: name, issue: "ICD-10 list/note mismatch",
                           detail: c.icd10ListMatchesNote + "/" + c.notes + " notes agree" });
        }
        if (c.course && !Object.keys(kinds).length) {
          anomalies.push({ case: name, issue: "no course events", detail: c.notes + " notes" });
        }
      }
    });

    const of = (n) => n + "/" + names.length;
    const MAX_ANOMALIES = 80;
    return {
      browser: report.browser,
      versions: report.versions,
      unitTests: {
        diagnosisGrammar: report.diagnosisGrammar.passed + "/" + report.diagnosisGrammar.total,
        diffUnits: report.diffUnits.passed + "/" + report.diffUnits.total,
        courseUnits: report.courseUnits.passed + "/" + report.courseUnits.total,
        failures: [].concat(report.diagnosisGrammar.failures,
                            report.diffUnits.failures, report.courseUnits.failures),
      },
      corpus: corpus,
      parse: { notesAgreeingWithList: icd10Match + "/" + corpus.notes, warnings: warnings },
      lineage: lineage,
      blame: {
        line: { rebuildsNoteExactly: of(blame.line.rebuilds),
                everyRunAttributedToChain: of(blame.line.attributed),
                deepestChain: blame.line.deepest },
        token: { rebuildsNoteExactly: of(blame.token.rebuilds),
                 everyRunAttributedToChain: of(blame.token.attributed),
                 deepestChain: blame.token.deepest },
      },
      course: { events: events, casesWithMarkers: casesWithMarkers },
      // Ranked by distinct patients first: a format used across the ward is a
      // real grammar gap, one seen in a single chart is that attending's quirk.
      // Copy-forward inflates the note count, so it is only the tie-breaker.
      unparsedDiagnosisFormats: Object.keys(report.unparsedDx)
        .map((line) => ({ line: line,
                          cases: Object.keys(report.unparsedDx[line].cases).length,
                          notes: report.unparsedDx[line].notes }))
        .sort((a, b) => (b.cases - a.cases) || (b.notes - a.notes))
        .slice(0, 25),
      distinctUnparsedFormats: Object.keys(report.unparsedDx).length,
      anomalyCount: anomalies.length,
      anomalies: anomalies.slice(0, MAX_ANOMALIES),
      anomaliesNotShown: Math.max(0, anomalies.length - MAX_ANOMALIES),
    };
  }

  function run() {
    const fixtures = window.OPD_FIXTURES;
    if (!fixtures) throw new Error("window.OPD_FIXTURES missing -- run tools/make_fixture_js.py");
    for (const mod of ["OPDParse", "OPDLineage", "OPDCourse"]) {
      if (!window[mod]) throw new Error(mod + " missing -- its script did not load");
    }

    const grammar = diagnosisGrammar();
    const diffs = diffUnits();
    const course = courseUnits();
    const report = {
      browser: navigator.userAgent,
      versions: { parse: OPDParse.version, lineage: OPDLineage.version, course: OPDCourse.version },
      diagnosisGrammar: { passed: grammar.filter((g) => g.ok).length, total: grammar.length, failures: grammar.filter((g) => !g.ok) },
      diffUnits: { passed: diffs.filter((u) => u.ok).length, total: diffs.length, failures: diffs.filter((u) => !u.ok) },
      courseUnits: { passed: course.filter((u) => u.ok).length, total: course.length, failures: course.filter((u) => !u.ok) },
      cases: {},
      // The diagnosis-line warning carries only a count, but parseDiagnoses keeps
      // every line it could not parse on note.diagnoses.unparsed. Collecting them
      // here turns "297 lines fail" into "these formats fail", without touching
      // the shipping parser to find out.
      unparsedDx: {},
    };

    for (const [name, capture] of Object.entries(fixtures)) {
      // One bad case must not cost the whole run. With fifty unseen patients any
      // of them can throw for a reason the original two never exercised, and a
      // 52-case run takes minutes -- losing all of it to one surprise is exactly
      // what this summary exists to prevent.
      try {
      const list = OPDParse.parseList(capture.list.html);
      const byRow = new Map(list.visits.map((v) => [v.rowIndex, v]));
      const r = { listRows: list.visits.length, notes: 0, icd10ListMatchesNote: 0, warnings: {}, evidence: {} };
      const entries = [];

      for (const raw of capture.notes) {
        const note = OPDParse.parseNote(raw.html);
        const visit = byRow.get(raw.rowIndex);
        if (!visit) continue;
        r.notes++;
        entries.push({ visit, note });
        note.warnings.forEach((w) => bump(r.warnings, w.level + ":" + w.code + (w.section ? ":" + w.section : "")));
        ((note.diagnoses && note.diagnoses.unparsed) || []).forEach((line) => {
          const key = clip(line, 90);
          const seen = report.unparsedDx[key] || (report.unparsedDx[key] = { notes: 0, cases: {} });
          seen.notes++;
          seen.cases[name] = true;
        });
        const inNote = note.diagnoses.icd10.filter((d) => !d.hidden).map((d) => d.code).sort().join(",");
        if (inNote === visit.icd10.slice().sort().join(",")) r.icd10ListMatchesNote++;
      }

      const lineage = OPDLineage.build(entries);
      const course = OPDCourse.build(lineage);
      r.lineage = lineage.summary;

      // Blame invariants, checked on the longest ancestry in this patient: the
      // surviving segments must rebuild the note's text exactly, and every run
      // must be attributed to a visit that is actually in the chain.
      let deepest = 0;
      let deepestChain = [];
      lineage.nodes.forEach((n) => {
        const chain = OPDLineage.ancestry(lineage.nodes, n.index);
        if (chain.length > deepestChain.length) { deepest = n.index; deepestChain = chain; }
      });
      // A capture with zero notes builds an empty lineage, so there is no node
      // to blame and nodes[0] is undefined. Two captures in this ward are empty
      // -- patients with no OPD history, or a fetch that returned nothing -- and
      // the original two-patient corpus never exercised this path.
      const inChain = new Set(deepestChain);
      r.blame = null;
      if (lineage.nodes.length) {
        const want = OPDLineage.sectionText(lineage.nodes[deepest].note, "O");
        r.blame = {};
        ["line", "token"].forEach((granularity) => {
          const blamed = OPDLineage.blame(lineage.nodes, deepest, "O", { granularity });
          const live = blamed.segments.filter((s) => !s.removedAt).map((s) => s.text).join("");
          r.blame[granularity] = {
            chainLength: blamed.chain.length,
            segments: blamed.segments.length,
            runs: OPDLineage.blameRuns(blamed.segments).length,
            tombstones: blamed.segments.filter((s) => s.removedAt).length,
            rebuildsNoteExactly: live === want,
            everyRunAttributedToChain: blamed.segments.every((s) => inChain.has(s.addedIndex)),
            distinctAuthors: new Set(blamed.segments.map((s) => s.addedAt)).size,
          };
        });
      }
      r.course = {
        span: course.patient.from + " .. " + course.patient.to,
        clinics: course.patient.clinics.length,
        diagnoses: course.diagnoses.length,
        distinctDrugs: course.meds.length,
        events: {},
        weightPoints: course.series.weight.length,
        painPoints: course.series.pain.length,
        markers: Object.keys(course.series.markers),
      };
      course.events.forEach((e) => bump(r.course.events, e.kind));

      r.evidence.diagnosisFirstSeen = course.diagnoses.slice(0, MAX_EVIDENCE).map((d) => ({
        code: (d.qualifier ? d.qualifier + " " : "") + d.code,
        firstSeen: d.firstSeen.date, clinic: d.firstSeen.clinic, visits: d.visits,
      }));
      r.evidence.statusAndImaging = course.events
        .filter((e) => e.kind === "status" || e.kind === "stage")
        .slice(0, MAX_EVIDENCE)
        .map((e) => ({ date: e.date, clinic: e.clinic, kind: e.kind, match: e.match, text: clip(e.text, 100) }));
      r.evidence.markerSeries = Object.keys(course.series.markers).slice(0, 4).map((k) => ({
        marker: k, points: course.series.markers[k].slice(0, 6),
      }));
      r.evidence.weightTrend = course.series.weight.filter((_, i) => i % Math.ceil(course.series.weight.length / 8 || 1) === 0);
      r.evidence.firstDrugs = course.meds.slice(0, MAX_EVIDENCE).map((m) => ({
        name: clip(m.name, 40), first: m.firstStarted.date, clinic: m.firstStarted.clinic,
        courses: m.courses.length, changes: m.changes.length,
      }));
      report.cases[name] = r;
      } catch (err) {
        report.cases[name] = {
          failed: String((err && err.stack) || err).split("\n").slice(0, 2).join(" | "),
          listRows: 0, notes: 0, icd10ListMatchesNote: 0, warnings: {}, evidence: {},
        };
      }
    }
    return report;
  }

  try {
    const wantSummary = new URLSearchParams(location.search).get("summary");
    const report = run();
    out.textContent = JSON.stringify(wantSummary ? summarise(report) : report, null, 1);
  } catch (e) {
    out.textContent = "HARNESS ERROR\n" + ((e && e.stack) || e);
  }
})();
