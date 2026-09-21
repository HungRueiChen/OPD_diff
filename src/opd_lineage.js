/* OPD_diff -- copy-forward lineage, per-visit deltas, and blame over a chain.
 *
 * Serial OPD notes are written by copying the previous note forward and editing
 * it, so a visit's real content is the EDIT, not the text. This module finds each
 * note's parent, reports what changed against it, and can attribute every run of
 * text in a note to the visit that introduced it.
 *
 * Parent selection is measured, not assumed (see the project notes): no fixed key
 * -- clinic code, clinic name or attending -- identifies a stream reliably, and
 * cross-clinic inheritance is common, because a service's first visit usually
 * copies another service's note. So the parent is the most similar EARLIER note,
 * with one correction: when the previous visit to the same clinic is within
 * TIE_MARGIN of the best score, it wins, which keeps timelines stable and
 * intuitive instead of hopping between near-identical ancestors.
 *
 * Thresholds come from two real patients (49 and 75 notes): at or above COPIED
 * the note is a copy-forward edit; between REWRITTEN and COPIED it was partly
 * rewritten (common after a long gap) and its diff is still worth showing; below
 * REWRITTEN there is no usable ancestor and the note is a baseline.
 *
 * Similarity is an LCS ratio over tokens, close to Python's SequenceMatcher but
 * not identical to it, which is why the thresholds are deliberately coarse.
 *
 * Target: Chrome/Edge 109 (the last Windows 7 releases).
 */
(function (root) {
  "use strict";

  const COPIED = 0.6;
  const REWRITTEN = 0.2;
  const TIE_MARGIN = 0.02;
  const SHINGLE = 3;
  const SHORTLIST = 5;
  const MAX_TOKENS = 1500;
  // Written out rather than as a literal: an 8-digit run that is not a plausible
  // date is exactly what deid.py flags as a bare chart number.
  const DAY_MS = 24 * 60 * 60 * 1000;

  const segmenter = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? new Intl.Segmenter("zh-Hant", { granularity: "word" })
    : null;

  /* Tokenize into {t, i, j}: the token and its span in the source.
   *
   * Clinical text mixes Chinese and English, so whitespace alone is not a word
   * boundary and Intl.Segmenter (Chrome 87+) does the splitting. Keeping offsets
   * is what lets a diff be rendered as the EXACT original text -- and what lets
   * the view highlight a changed run in place. Joining tokens back with spaces
   * would turn "s/p" into "s / p" and a date into "2025 - 10 - 21".
   */
  function tokenize(text) {
    const source = String(text == null ? "" : text);
    const tokens = [];
    if (!source) return { source, tokens };
    if (segmenter) {
      for (const seg of segmenter.segment(source)) {
        if (!seg.segment.trim()) continue;
        tokens.push({ t: seg.segment, i: seg.index, j: seg.index + seg.segment.length });
        if (tokens.length >= MAX_TOKENS) break;
      }
    } else {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(source)) !== null && tokens.length < MAX_TOKENS) {
        tokens.push({ t: m[0], i: m.index, j: m.index + m[0].length });
      }
    }
    return { source, tokens };
  }

  /* Accept a sequence, a raw string, or a plain array of token strings. */
  function asSeq(input) {
    if (input && typeof input === "object" && Array.isArray(input.tokens)) return input;
    if (Array.isArray(input)) return tokenize(input.join(" "));
    return tokenize(input);
  }

  function shingles(seq, k) {
    const tokens = asSeq(seq).tokens;
    const set = new Set();
    if (!tokens.length) return set;
    for (let i = 0; i <= Math.max(0, tokens.length - k); i++) {
      let key = "";
      for (let n = 0; n < k && i + n < tokens.length; n++) key += tokens[i + n].t + " ";
      set.add(key);
    }
    return set;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    small.forEach((v) => { if (large.has(v)) shared++; });
    return shared / (a.size + b.size - shared);
  }

  // Longest common subsequence table, reused across calls to avoid re-allocating
  // a few hundred kilobytes per comparison.
  let scratch = null;
  function lcsTable(a, b) {
    const w = b.length + 1;
    const need = (a.length + 1) * w;
    if (!scratch || scratch.length < need) scratch = new Int32Array(need);
    const dp = scratch;
    dp.fill(0, 0, need);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i * w + j] = a[i].t === b[j].t
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    return { dp, w };
  }

  /* Two empty texts score 0, not 1: absence of text is not evidence of lineage,
   * and scoring it as a perfect copy would link unrelated notes. */
  function similarity(aInput, bInput) {
    const a = asSeq(aInput).tokens;
    const b = asSeq(bInput).tokens;
    if (!a.length || !b.length) return 0;
    const { dp } = lcsTable(a, b);
    return (2 * dp[0]) / (a.length + b.length);
  }

  /* Changed regions as {start, end, text} spans into each side's own source:
   * `added` indexes the NEW text, `removed` indexes the OLD one. One call
   * therefore gives a side-by-side view both halves of a pair can render. */
  function diffRanges(aInput, bInput) {
    const aSeq = asSeq(aInput);
    const bSeq = asSeq(bInput);
    const a = aSeq.tokens;
    const b = bSeq.tokens;
    const added = [];
    const removed = [];
    const source = { before: aSeq.source, after: bSeq.source };
    const range = (seq, from, to) => ({
      start: seq.tokens[from].i,
      end: seq.tokens[to].j,
      text: seq.source.slice(seq.tokens[from].i, seq.tokens[to].j),
    });

    if (!a.length || !b.length) {
      if (b.length) added.push(range(bSeq, 0, b.length - 1));
      if (a.length) removed.push(range(aSeq, 0, a.length - 1));
      return { added, removed, source };
    }

    const { dp, w } = lcsTable(a, b);
    let i = 0;
    let j = 0;
    let delFrom = -1;
    let addFrom = -1;
    const flush = (delTo, addTo) => {
      if (delFrom >= 0) { removed.push(range(aSeq, delFrom, delTo)); delFrom = -1; }
      if (addFrom >= 0) { added.push(range(bSeq, addFrom, addTo)); addFrom = -1; }
    };
    while (i < a.length && j < b.length) {
      if (a[i].t === b[j].t) { flush(i - 1, j - 1); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { if (delFrom < 0) delFrom = i; i++; }
      else { if (addFrom < 0) addFrom = j; j++; }
    }
    while (i < a.length) { if (delFrom < 0) delFrom = i; i++; }
    while (j < b.length) { if (addFrom < 0) addFrom = j; j++; }
    flush(i - 1, j - 1);
    return { added, removed, source };
  }

  function diffRuns(aInput, bInput) {
    const ranges = diffRanges(aInput, bInput);
    return {
      added: ranges.added.map((x) => x.text),
      removed: ranges.removed.map((x) => x.text),
    };
  }

  // ------------------------------------------------------------------- lanes

  function medKey(med) {
    return String(med.name || "")
      .replace(/[#>*]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function medDose(med) {
    return [med.dose, med.unit, med.route, med.frequency].filter(Boolean).join(" ");
  }

  function addDays(isoDate, days) {
    const t = Date.parse(isoDate + "T00:00:00Z");
    return Number.isFinite(t) ? new Date(t + days * DAY_MS).toISOString().slice(0, 10) : null;
  }

  /* When a prescription runs out. A course with no day count is treated as a
   * single administration on its start date (the STAT and injection rows). */
  function medEnds(med, visitDate) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(med.startDate || "")) ? med.startDate : visitDate;
    if (!start) return null;
    const days = parseInt(med.days, 10);
    return addDays(start, Number.isFinite(days) && days > 0 ? days : 1);
  }

  /* Medication events between two visits.
   *
   * There is deliberately no "stopped": each visit's 用藥記錄 lists only what was
   * prescribed AT that visit, so a 14-day drug absent from a visit three days
   * later has not been discontinued -- it is simply still running. Reporting that
   * as "stopped" would invent a clinical event. What can be said is that a course
   * has ENDED by this visit's date.
   */
  function medLane(beforeMeds, beforeDate, afterMeds, afterDate) {
    const prev = new Map((beforeMeds || []).map((m) => [medKey(m), m]));
    const next = new Map((afterMeds || []).map((m) => [medKey(m), m]));
    const started = [];
    const changed = [];
    const ended = [];
    next.forEach((med, key) => {
      const was = prev.get(key);
      if (!was) started.push({ name: med.name, dose: medDose(med), days: med.days || null });
      else if (medDose(was) !== medDose(med)) {
        changed.push({ name: med.name, from: medDose(was), to: medDose(med) });
      }
    });
    prev.forEach((med, key) => {
      if (next.has(key)) return;
      const endsOn = medEnds(med, beforeDate);
      if (endsOn && afterDate && endsOn <= afterDate) {
        ended.push({ name: med.name, dose: medDose(med), endedOn: endsOn });
      }
    });
    return { started, changed, ended };
  }

  function codeLane(before, after, keyOf, labelOf) {
    const prev = new Map((before || []).map((x) => [keyOf(x), x]));
    const next = new Map((after || []).map((x) => [keyOf(x), x]));
    const added = [];
    const removed = [];
    next.forEach((x, k) => { if (!prev.has(k)) added.push(labelOf(x)); });
    prev.forEach((x, k) => { if (!next.has(k)) removed.push(labelOf(x)); });
    return { added, removed };
  }

  function lastPain(note) {
    const list = (note.pain || []).filter((p) => p.score != null);
    return list.length ? list[list.length - 1] : null;
  }

  function numberDelta(before, after) {
    if (before == null || after == null) return null;
    return { from: before, to: after, delta: Math.round((after - before) * 10) / 10 };
  }

  function visibleIcd10(note) {
    return (note.diagnoses.icd10 || []).filter((d) => !d.hidden);
  }

  function sectionText(note, key) {
    if (!note) return "";
    const section = note.sections[key];
    return (section && (section.diffText || section.text)) || "";
  }

  function diffNotes(parentNote, note, parentDate, noteDate) {
    const sections = {};
    for (const k of ["S", "O", "P"]) {
      sections[k] = diffRanges(sectionText(parentNote, k), sectionText(note, k));
      sections[k].addedText = sections[k].added.map((x) => x.text);
      sections[k].removedText = sections[k].removed.map((x) => x.text);
    }
    const painNow = lastPain(note);
    const painBefore = parentNote ? lastPain(parentNote) : null;
    return {
      sections,
      diagnoses: codeLane(parentNote ? visibleIcd10(parentNote) : [], visibleIcd10(note),
                          (d) => (d.qualifier ? d.qualifier + " " : "") + d.code,
                          (d) => (d.qualifier ? d.qualifier + " " : "") + d.code + " " + d.text),
      meds: medLane(parentNote ? parentNote.meds : [], parentDate, note.meds, noteDate),
      orders: codeLane(parentNote ? parentNote.orders : [], note.orders,
                       (o) => o.code, (o) => o.code + " " + o.name),
      pain: {
        score: painNow ? painNow.score : null,
        previous: painBefore ? painBefore.score : null,
        change: painNow && painBefore ? painNow.score - painBefore.score : null,
      },
      vitals: {
        weight: numberDelta(parentNote && parentNote.vitals ? parentNote.vitals.weight : null,
                            note.vitals ? note.vitals.weight : null),
        systolic: numberDelta(parentNote && parentNote.vitals ? parentNote.vitals.systolic : null,
                              note.vitals ? note.vitals.systolic : null),
      },
    };
  }

  // ------------------------------------------------------------------- blame

  /* The chain of notes this one was copied from, oldest first, ending at index. */
  function ancestry(nodes, index) {
    const chain = [];
    const seen = new Set();
    let at = index;
    while (at != null && at >= 0 && !seen.has(at)) {
      seen.add(at);
      chain.unshift(at);
      at = nodes[at] && nodes[at].parent ? nodes[at].parent.index : null;
    }
    return chain;
  }

  /* Per-token slices of a text: each slice is its token plus the whitespace up to
   * the next token, the first slice carrying any leading whitespace. The slices
   * therefore concatenate back to the source exactly. */
  function perTokenSlices(text) {
    const seq = tokenize(text);
    const slices = [];
    let at = 0;
    seq.tokens.forEach((tk, n) => {
      const end = (n + 1 < seq.tokens.length) ? seq.tokens[n + 1].i : text.length;
      slices.push(text.slice(at, end));
      at = end;
    });
    return { tokens: seq.tokens, slices };
  }

  /* Line slices, each carrying its own newline. Lines are what git blame walks,
   * and for these notes they are the readable unit: a single CTCAE line gets its
   * dates and values rewritten at every visit, so word-level blame on it shows a
   * decade of overwrites at once. */
  function perLineSlices(text) {
    const tokens = [];
    const slices = [];
    const lines = text.split("\n");
    let at = 0;
    lines.forEach((line, n) => {
      const end = at + line.length + (n < lines.length - 1 ? 1 : 0);
      slices.push(text.slice(at, end));
      tokens.push({ t: line.trim() });
      at = end;
    });
    return { tokens, slices };
  }

  function sliceUnits(text, granularity) {
    return granularity === "line" ? perLineSlices(text) : perTokenSlices(text);
  }

  function segmentsOf(text, date, index, granularity) {
    const cut = sliceUnits(text, granularity);
    return cut.tokens.map((tk, n) => ({
      token: tk.t, text: cut.slices[n], addedAt: date, addedIndex: index,
      removedAt: null, removedIndex: null,
    }));
  }

  /* Blame one section across a note's whole ancestry.
   *
   * Returns every run of text that has EVER appeared in the chain, each tagged
   * with the visit that introduced it and, when it no longer survives, the visit
   * that dropped it. Removed text is kept as a tombstone rather than discarded,
   * so a reader can see what an attending took out as well as what they added.
   *
   * Surviving segments are re-anchored to each new version's own slices as the
   * walk proceeds. Whitespace belongs to the text, not to a token: without that,
   * a tombstoned neighbour takes its spacing with it and the live segments drift
   * out of step with the note -- a blame view showing text the note never had.
   */
  function blame(nodes, index, sectionKey, options) {
    const key = sectionKey || "O";
    const granularity = (options && options.granularity) || "token";
    const chain = ancestry(nodes, index);
    if (!chain.length) return { chain: [], segments: [] };

    const first = nodes[chain[0]];
    const segments = segmentsOf(sectionText(first.note, key), first.visit.date, chain[0], granularity);

    for (let step = 1; step < chain.length; step++) {
      const node = nodes[chain[step]];
      const cut = sliceUnits(sectionText(node.note, key), granularity);
      const b = cut.tokens;

      const liveAt = [];
      segments.forEach((seg, i) => { if (!seg.removedAt) liveAt.push(i); });
      const a = liveAt.map((i) => ({ t: segments[i].token }));

      const made = (n) => ({
        token: b[n].t, text: cut.slices[n],
        addedAt: node.visit.date, addedIndex: chain[step],
        removedAt: null, removedIndex: null,
      });
      const drop = (at) => {
        segments[at].removedAt = node.visit.date;
        segments[at].removedIndex = chain[step];
      };

      const inserts = [];
      let i = 0;
      let j = 0;
      if (!a.length || !b.length) {
        for (let n = 0; n < b.length; n++) inserts.push({ at: segments.length, seg: made(n) });
        liveAt.forEach(drop);
      } else {
        const { dp, w } = lcsTable(a, b);
        while (i < a.length && j < b.length) {
          if (a[i].t === b[j].t) {
            segments[liveAt[i]].text = cut.slices[j];
            i++;
            j++;
          } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
            drop(liveAt[i]);
            i++;
          } else {
            inserts.push({ at: i < liveAt.length ? liveAt[i] : segments.length, seg: made(j) });
            j++;
          }
        }
        while (i < a.length) { drop(liveAt[i]); i++; }
        while (j < b.length) { inserts.push({ at: segments.length, seg: made(j) }); j++; }
      }

      // Apply back to front so earlier insertion points stay valid.
      for (let n = inserts.length - 1; n >= 0; n--) {
        segments.splice(inserts[n].at, 0, inserts[n].seg);
      }
    }

    return {
      chain: chain.map((i) => ({
        index: i,
        date: nodes[i].visit.date,
        clinic: (nodes[i].visit.dept && nodes[i].visit.dept.clinic) || null,
      })),
      segments,
    };
  }

  /* Merge neighbouring segments that share a fate, for rendering. */
  function blameRuns(segments) {
    const runs = [];
    (segments || []).forEach((seg) => {
      const last = runs[runs.length - 1];
      if (last && last.addedAt === seg.addedAt && last.removedAt === seg.removedAt) {
        last.text += seg.text;
      } else {
        runs.push({ text: seg.text, addedAt: seg.addedAt, addedIndex: seg.addedIndex,
                    removedAt: seg.removedAt, removedIndex: seg.removedIndex });
      }
    });
    return runs;
  }

  // ----------------------------------------------------------------- lineage

  // Lineage follows O:, where copy-forward lives. A note with no O: (some
  // screening clinics) falls back to S: so it is not stranded as a false baseline.
  function lineageText(note) {
    return sectionText(note, "O") || sectionText(note, "S");
  }

  function byDateThenTime(a, b) {
    const d = String(a.visit.date || "").localeCompare(String(b.visit.date || ""));
    return d !== 0 ? d : String(a.visit.time || "").localeCompare(String(b.visit.time || ""));
  }

  function build(entries, options) {
    const opts = Object.assign({ copied: COPIED, rewritten: REWRITTEN, tieMargin: TIE_MARGIN }, options);
    const items = entries.slice().sort(byDateThenTime);
    const prepared = items.map((e) => {
      const seq = tokenize(lineageText(e.note));
      return { entry: e, seq, shingles: shingles(seq, SHINGLE) };
    });

    const nodes = [];
    for (let i = 0; i < prepared.length; i++) {
      const self = prepared[i];
      const clinic = self.entry.visit.dept && self.entry.visit.dept.clinic;

      let previousSameClinic = null;
      const ranked = [];
      for (let j = 0; j < i; j++) {
        const other = prepared[j];
        const otherClinic = other.entry.visit.dept && other.entry.visit.dept.clinic;
        if (clinic && otherClinic === clinic) previousSameClinic = j;
        ranked.push({ index: j, cheap: jaccard(other.shingles, self.shingles) });
      }
      ranked.sort((x, y) => y.cheap - x.cheap);

      // Cheap shingle overlap picks the shortlist; the exact ratio decides. On two
      // real patients this shortlist chose the same parent as an exhaustive scan.
      const considered = new Set(ranked.slice(0, SHORTLIST).map((r) => r.index));
      if (previousSameClinic != null) considered.add(previousSameClinic);

      let best = null;
      const scores = new Map();
      considered.forEach((j) => {
        const score = similarity(prepared[j].seq, self.seq);
        scores.set(j, score);
        if (!best || score > best.score) best = { index: j, score };
      });

      let parent = null;
      if (best && best.score >= opts.rewritten) {
        let chosen = best;
        if (previousSameClinic != null && previousSameClinic !== best.index) {
          const prevScore = scores.get(previousSameClinic);
          if (prevScore != null && best.score - prevScore <= opts.tieMargin) {
            chosen = { index: previousSameClinic, score: prevScore };
          }
        }
        const parentVisit = prepared[chosen.index].entry.visit;
        parent = {
          index: chosen.index,
          date: parentVisit.date,
          clinic: parentVisit.dept && parentVisit.dept.clinic,
          similarity: Math.round(chosen.score * 100) / 100,
          relation: chosen.score >= opts.copied ? "copied" : "rewritten",
          sameClinic: Boolean(clinic) && (parentVisit.dept && parentVisit.dept.clinic) === clinic,
        };
      }

      const parentEntry = parent ? prepared[parent.index].entry : null;
      nodes.push({
        index: i,
        visit: self.entry.visit,
        note: self.entry.note,
        parent,
        isBaseline: parent === null,
        delta: diffNotes(parentEntry ? parentEntry.note : null, self.entry.note,
                         parentEntry ? parentEntry.visit.date : null, self.entry.visit.date),
      });
    }

    const summary = {
      notes: nodes.length,
      baseline: nodes.filter((n) => n.isBaseline).length,
      copied: nodes.filter((n) => n.parent && n.parent.relation === "copied").length,
      rewritten: nodes.filter((n) => n.parent && n.parent.relation === "rewritten").length,
      crossClinicParents: nodes.filter((n) => n.parent && !n.parent.sameClinic).length,
    };
    return { nodes, summary };
  }

  const api = { build, diffNotes, diffRanges, diffRuns, similarity, jaccard, tokenize, shingles,
                ancestry, blame, blameRuns, sectionText,
                thresholds: { COPIED, REWRITTEN, TIE_MARGIN }, version: 4 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDLineage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
