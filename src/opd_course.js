/* OPD_diff -- fold per-visit deltas into one patient-level disease course.
 *
 * The lineage module says what each visit ADDED. This module answers the question
 * a clinician actually asks of a four-year record: what happened to this disease,
 * and why did treatment change?
 *
 * Two rules govern everything here:
 *
 *   1. Nothing is asserted. No entry says "progression"; an entry says "on this
 *      date, at this clinic, the attending newly wrote THIS", and carries the
 *      exact text plus its visit so it can be checked. A regex is not a clinical
 *      judgement, and a timeline that quietly upgraded one into a conclusion
 *      would be both wrong sometimes and untrustworthy always.
 *   2. Deduplication is patient-level. Copy-forward means one sentence reappears
 *      in every descendant note, and a service's first visit re-adds the whole
 *      inherited text; without dedup a single CA-125 result becomes a four-point
 *      "trend" and one stage becomes three events.
 *
 * Target: Chrome/Edge 109 (the last Windows 7 releases).
 */
(function (root) {
  "use strict";

  // Spelled-out response language is unambiguous. The abbreviations are not --
  // "PR" is per rectum at least as often as partial response, "PD" can be
  // Parkinson's -- so they only count next to an imaging word.
  const RESPONSE_WORDS = /\b(complete response|partial response|near complete|stable disease|progressive disease|progression|regression|recurrence|recurrent|no residual|residual tumou?r|no evidence of disease|NED)\b/i;
  const RESPONSE_ABBR = /\b(CR|PR|SD|PD)\b/;
  const IMAGING = /\b(CT|PET(?:-CT)?|MRI|WBBS|bone scan|echo|EGD|panendoscopy|ultrasound|sonography|US|mammograph\w*|CXR|X-ray|scan)\b/i;
  const TREATMENT = /\b(OP|operation|surgery|resection|dissection|biopsy|NACT|CCRT|RT|radiotherapy|irradiation|chemotherapy|chemo|CTx|immunotherapy|target(?:ed)? therapy|hormone therapy|Pembro\w*|Keytruda|cisplatin|carboplatin|C\d{1,2}(?:-\d{1,2})?)\b/i;
  const BARE_CYCLE = /^C\d{1,2}(?:-\d{1,2})?$/i;
  const RT_CONTEXT = /\b(Gy|cGy|fx|fraction|simulation|plan\w*|start\w*|finish\w*|complete\w*|course|s\/p|wait for|post|boost|palliative)\b|\d{4}[-/]?\d{2}/i;
  const STAGE = /\b((?:yc|yp|rc|rp|c|p|r|a)?T\d[a-z]?\s?N\d[a-z]?\s?M\d[a-z]?)\b/;
  const MARKER = /\b(CA\s?125|CA\s?19-9|CA\s?15-3|CEA|AFP|PSA|SCC(?:-Ag)?|β?-?HCG|CPS|TPS)\b\s*[:=]?\s*([<>]?\s?\d+(?:\.\d+)?)/i;

  // Some markers are reported as a state, not a number: "HER2 amplification",
  // "MSI-H", "EGFR mutation". They are emitted as markers with value null, which
  // keeps them on the timeline while Number.isFinite() in build() stops them
  // drawing a point on a trend line that has no numeric axis.
  // ER and PR are deliberately absent: "PR" is per rectum or partial response
  // far more often than progesterone receptor in these notes.
  const MARKER_QUAL = /\b(HER2|PD-?L1|MSI(?:-H)?|dMMR|pMMR|EGFR|ALK|ROS1|BRAF|KRAS|BRCA[12]?)\b[\s:=]*(amplification|amplified|positive|negative|mutation|mutated|wild[-\s]?type|high|low|\(\s*[+-]\s*\))/i;

  // Exam findings: the structural words an attending uses for what they saw.
  // Chosen by distinct-patient frequency across a 52-patient ward sample, so
  // these are ward vocabulary rather than one attending's habit. Negation is NOT
  // handled here -- "No ascites is seen" still raises a finding -- because every
  // entry quotes the sentence it came from, so the reader sees the negation.
  const FINDING = /\b(lesions?|mass|masses|nodules?|metastas[ie]s|metastatic|mets|lymphadenopathy|adenopathy|effusions?|ascites|thickening|infiltration|enhancing|uptake)\b/i;

  // CTCAE grades appear as "(G0)".."(G3)". They also appear as "(G-1)" and
  // "(G-7)" -- 24 and 141 hits across the ward, against 76 real G3s -- and those
  // are NOT grades: CTCAE stops at 5 and there is no G4 or G5 anywhere in the
  // corpus. Requiring a digit immediately after "G" excludes the dashed forms as
  // unknown rather than silently reading them as grade 1 and grade 7.
  // The grade is NOT followed by ")" in practice. Measured across the ward, all
  // 75 real G3 tokens are followed by a space, because the note continues inside
  // the same parentheses: "(G3 補充說明:檢驗日:…)". Only G0 usually closes
  // immediately. The terminator therefore accepts ")", whitespace, an escaped
  // newline (a grade can end a wrapped line), or end of input -- but still
  // requires a DIGIT straight after "G", which is what keeps the non-grade
  // sentinels G-1 and G-7 out.
  const TOXICITY_GRADED = /([A-Za-z][A-Za-z\s\-()/]{2,40}?)\(\s*G\s*([0-5])(?=\s|\)|\\|$)/;
  const MIN_TOXICITY_GRADE = 3;
  const DATE_IN_TEXT = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{8}|\d{4}[-/]\d{1,2})\b/;

  // A symptom worsening is not disease progression. "SORE THROAT IN PROGRESSION
  // FOR MORE THAN 1 YEAR" is a presenting complaint, and it sits in a copied
  // header, so without this gate it would be re-reported at every clinic.
  const SYMPTOM = /\b(sore throat|throat pain|pain|ache|swelling|cough|dyspn\w*|short(?:ness)? of breath|itch\w*|numb\w*|fever|nausea|vomit\w*|diarrh\w*|constipat\w*|fatigue|weakness|bleeding|discharge|hoarseness|dysphagia)\b/i;
  const DURATION = /\bfor\s+(?:more\s+than\s+|about\s+|around\s+)?(?:a|an|one|two|three|several|\d+)\s*(?:day|week|month|year)s?\b/i;

  const MIN_TEXT = 4;
  const MAX_TEXT = 300;
  const CONTEXT = 30;

  function clip(s, n) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function near(text, index, pattern, radius) {
    return pattern.test(text.slice(Math.max(0, index - radius), index + radius));
  }

  /* Undo the HIS's line wrapping. It breaks mid-word -- "Hyponatre\nmia" -- so a
   * blind whitespace collapse leaves "Hyponatre mia". This is a HEURISTIC: a
   * newline between a letter and a lowercase letter is treated as a wrap and
   * closed up, anything else becomes a space. It cannot be exact, because the
   * source does not record where it broke a word and where it broke a phrase. */
  function dewrap(s) {
    return String(s == null ? "" : s)
      .replace(/([A-Za-z])[ \t]*\n[ \t]*([a-z])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* Classify one newly written run of text. A run can raise several kinds -- an
   * imaging line that also states a response is both -- so this returns a list. */
  function classify(text) {
    const kinds = [];
    const imaging = IMAGING.exec(text);
    if (imaging) kinds.push({ kind: "imaging", match: imaging[1] });

    const spelled = RESPONSE_WORDS.exec(text);
    if (spelled) {
      const symptomNearby = near(text, spelled.index, SYMPTOM, CONTEXT);
      const durationAfter = DURATION.test(text.slice(spelled.index, spelled.index + 60));
      if (!symptomNearby && !durationAfter) kinds.push({ kind: "status", match: spelled[1] });
    } else {
      const abbr = RESPONSE_ABBR.exec(text);
      if (abbr && near(text, abbr.index, IMAGING, 40)) {
        kinds.push({ kind: "status", match: abbr[1] });
      }
    }

    const stage = STAGE.exec(text);
    if (stage) kinds.push({ kind: "stage", match: stage[1].replace(/\s+/g, "") });

    const treatment = TREATMENT.exec(text);
    if (treatment) {
      // A bare cycle label says nothing without a date beside it, and in these
      // notes "RT" is laterality ("RT NECK", "RT PE FOLD") far more often than
      // radiotherapy -- so it only counts near dose, scheduling or a date.
      const bareCycle = BARE_CYCLE.test(treatment[1]) && !DATE_IN_TEXT.test(text);
      const looseRT = /^RT$/i.test(treatment[1]) && !near(text, treatment.index, RT_CONTEXT, 30);
      if (!bareCycle && !looseRT) kinds.push({ kind: "treatment", match: treatment[1] });
    }

    const markers = new RegExp(MARKER.source, "gi");
    let marker;
    while ((marker = markers.exec(text)) !== null) {
      kinds.push({
        kind: "marker",
        match: marker[1].replace(/\s+/g, "").toUpperCase(),
        value: parseFloat(String(marker[2]).replace(/[<>\s]/g, "")),
      });
    }

    const qualitative = MARKER_QUAL.exec(text);
    if (qualitative) {
      kinds.push({
        kind: "marker",
        match: qualitative[1].replace(/\s+/g, "").toUpperCase(),
        value: null,
        state: qualitative[2].toLowerCase().replace(/\s+/g, " "),
      });
    }

    const finding = FINDING.exec(text);
    if (finding) kinds.push({ kind: "finding", match: finding[1].toLowerCase() });

    // Only grade 3 and above. Grade 0-2 is the overwhelming bulk of these blocks
    // (3953 of 4030 graded tokens) and says nothing a reader needs; anything
    // genuinely severe is written out as prose elsewhere in the note anyway.
    // A CTCAE block arrives as ONE added-text run holding dozens of graded
    // findings separated by ";". Measured across the ward: 2180 items are
    // preceded by ";", while the 1089 newlines fall INSIDE items, where a value
    // wraps ("檢驗\n值:10") -- so splitting on newlines would cut items in half.
    //
    // Each item carries its own `text`. build() merges the hit AFTER the run's
    // text, so this overrides it; without that, a whole block collapsed into a
    // single event whose displayed text visibly contained the G0-G2 items this
    // category exists to exclude.
    text.split(";").forEach((item) => {
      const graded = TOXICITY_GRADED.exec(item);
      if (!graded) return;
      const grade = parseInt(graded[2], 10);
      if (grade < MIN_TOXICITY_GRADE) return;
      const term = dewrap(graded[1]);
      if (!term) return;
      kinds.push({
        kind: "toxicity",
        match: term + " G" + grade,
        grade: grade,
        text: clip(dewrap(item), MAX_TEXT),
      });
    });
    return kinds;
  }

  function build(lineage, options) {
    const opts = Object.assign({ sections: ["S", "O", "P"] }, options);
    const nodes = lineage.nodes || [];

    const diagnoses = new Map();
    const meds = new Map();
    const events = [];
    const seenEvents = new Set();
    const seenStages = new Set();
    const seenMarkers = new Set();
    const painByDate = new Map();
    const series = { weight: [], pain: [], markers: {} };
    const clinics = new Set();
    let lastStage = null;

    for (const node of nodes) {
      const visit = node.visit;
      const clinic = (visit.dept && visit.dept.clinic) || null;
      const where = {
        date: visit.date,
        clinic,
        visitKey: visit.key,
        nodeIndex: node.index,
        isBaseline: node.isBaseline,
      };
      if (clinic) clinics.add(clinic);

      // --- trends read from the note itself, not from the delta
      if (node.note.vitals && node.note.vitals.weight != null) {
        series.weight.push({ date: visit.date, value: node.note.vitals.weight, clinic });
      }
      // Copy-forward repeats every pain score in each descendant note, so keep one
      // reading per assessment date rather than one per note that quotes it.
      for (const p of node.note.pain || []) {
        if (p.score == null) continue;
        const day = p.date || visit.date;
        const seen = painByDate.get(day);
        if (!seen || seen.score !== p.score) painByDate.set(day, { date: day, score: p.score, clinic });
      }

      // --- diagnoses: first appearance across the whole record
      for (const d of node.note.diagnoses.icd10.filter((x) => !x.hidden)) {
        const key = (d.qualifier ? d.qualifier + " " : "") + d.code;
        const existing = diagnoses.get(key);
        if (!existing) {
          diagnoses.set(key, {
            code: d.code,
            text: d.text,
            qualifier: d.qualifier || null,
            ruleOut: d.qualifier === "R/O",
            firstSeen: where,
            lastSeen: where,
            visits: 1,
          });
        } else {
          existing.lastSeen = where;
          existing.visits++;
          if (!existing.text && d.text) existing.text = d.text;
        }
      }

      // --- medications: first course of each drug, and every dose change
      for (const m of node.delta.meds.started) {
        const key = m.name.replace(/\s+/g, " ").trim().toLowerCase();
        const seen = meds.get(key);
        const course = { date: visit.date, dose: m.dose, days: m.days, clinic };
        if (!seen) meds.set(key, { name: m.name, firstStarted: where, courses: [course], changes: [] });
        else seen.courses.push(course);
      }
      for (const m of node.delta.meds.changed) {
        const key = m.name.replace(/\s+/g, " ").trim().toLowerCase();
        const seen = meds.get(key);
        const change = { date: visit.date, from: m.from, to: m.to, clinic };
        if (seen) seen.changes.push(change);
        else meds.set(key, { name: m.name, firstStarted: where, courses: [], changes: [change] });
      }

      // --- what the attending newly wrote at this visit
      for (const section of opts.sections) {
        for (const run of node.delta.sections[section].addedText || []) {
          const text = clip(run, MAX_TEXT);
          if (text.replace(/\s+/g, "").length < MIN_TEXT) continue;
          const dateInText = DATE_IN_TEXT.exec(text);
          for (const hit of classify(text)) {
            // A stage or a lab value is a fact about the patient, not about this
            // visit: report it once, the first time it is written anywhere.
            if (hit.kind === "stage") {
              if (seenStages.has(hit.match)) continue;
              seenStages.add(hit.match);
            }
            if (hit.kind === "marker") {
              // Key on the value and any date stated in the text, never on the
              // surrounding sentence: the same result is re-quoted at each clinic
              // in different words, and three quotes of one CA-125 must not draw
              // a three-point trend. Two genuinely equal values on separate
              // visits merge as well -- the safe direction for a trend line.
              const markerKey = hit.match + "|" + hit.value + "|" + (dateInText ? dateInText[1] : "");
              if (seenMarkers.has(markerKey)) continue;
              seenMarkers.add(markerKey);
            }

            const event = Object.assign({
              text,
              section,
              statedDate: dateInText ? dateInText[1] : null,
            }, hit, where);
            if (hit.kind === "stage") {
              event.previousStage = lastStage;
              event.restaged = Boolean(lastStage && lastStage !== hit.match);
              lastStage = hit.match;
            }

            const key = [event.date, event.kind, event.match, event.text].join("|");
            if (seenEvents.has(key)) continue;
            seenEvents.add(key);
            events.push(event);

            if (hit.kind === "marker" && Number.isFinite(hit.value)) {
              (series.markers[hit.match] = series.markers[hit.match] || [])
                .push({ date: visit.date, value: hit.value, statedDate: event.statedDate, clinic });
            }
          }
        }
      }
    }

    const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
    events.sort(byDate);
    series.pain = Array.from(painByDate.values()).sort(byDate);
    series.weight.sort(byDate);
    Object.keys(series.markers).forEach((k) => series.markers[k].sort(byDate));

    const dates = nodes.map((n) => n.visit.date).filter(Boolean).sort();
    return {
      patient: {
        visits: nodes.length,
        from: dates[0] || null,
        to: dates[dates.length - 1] || null,
        clinics: Array.from(clinics).sort(),
      },
      diagnoses: Array.from(diagnoses.values()).sort((a, b) => byDate(a.firstSeen, b.firstSeen)),
      meds: Array.from(meds.values()).sort((a, b) => byDate(a.firstStarted, b.firstStarted)),
      events,
      series,
    };
  }

  const api = { build, classify, version: 2 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDCourse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
