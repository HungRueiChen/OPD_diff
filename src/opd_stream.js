/* OPD_diff -- assemble the model while the capture is still arriving.
 *
 * A patient with a long history takes a minute or two to read, because requests
 * are paced to avoid an abnormal-activity block. Waiting for the last visit
 * before showing the first is the wrong trade for a clinic: the visit list comes
 * back in ONE request, so every date, clinic, doctor and diagnosis code is known
 * before a single note has been fetched, and the notes themselves arrive newest
 * first -- which is the order a clinician wants them in anyway.
 *
 * This module turns that stream into a model the view can re-render from.
 *
 * WHY IT IS THROTTLED, and not rebuilt per note
 * ---------------------------------------------
 * OPDLineage.build() is quadratic: every note is scored against every earlier
 * one. Measured on the largest patient in the corpus (138 notes) it costs about
 * 600 ms, and rebuilding once per arriving note would spend roughly 145 SECONDS
 * of main-thread time over a load that only takes about 100 seconds of network.
 * Caching the tokenize/shingle pass does not rescue it -- that pass is only 4%
 * of the total; the cost is the pairwise scoring itself.
 *
 * So a rebuild is barred until COST_FACTOR times its own last measured duration
 * has passed. That keeps rebuild overhead near 1/(1+COST_FACTOR) of wall time
 * whatever the patient's size, and makes rebuilds automatically rarer as the
 * record grows -- which is exactly when each one costs more and matters less.
 * The cost measured is build AND render, because both freeze the same thread.
 *
 * ARRIVAL ORDER, and what it means for attribution
 * ------------------------------------------------
 * Notes arrive newest first, so a note's ancestors arrive AFTER it. Blame over a
 * partial capture is therefore provisional, and the view must say so. Measured
 * across one patient's whole load, 143 attribution changes moved to an older
 * visit and 2 moved to a newer one, so it is not a one-way convergence: when a
 * newly arrived older note re-points a parent, the chain can change shape and a
 * line can be re-credited slightly forward. Rare, but real.
 *
 * Target: Chrome/Edge 109 (the last Windows 7 releases).
 */
(function (root) {
  "use strict";

  // A rebuild is barred for this multiple of its own last duration.
  var COST_FACTOR = 4;
  var MIN_INTERVAL_MS = 300;

  var clock = (typeof performance === "object" && performance && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /* One model, from whatever has been parsed so far.
   *
   * `visits` is every visit the list advertised, including those not yet read,
   * so the picker can show the whole record immediately and fill it in. `loaded`
   * against `total` is what tells the reader -- and the view -- how much of the
   * picture is still missing. */
  function modelFrom(visits, entries, done, listWarnings) {
    var lineage = OPDLineage.build(entries);
    return {
      visits: visits,
      entries: entries,
      lineage: lineage,
      course: OPDCourse.build(lineage),
      loaded: entries.length,
      total: visits.length || entries.length,
      done: Boolean(done),
      listWarnings: listWarnings || []
    };
  }

  function parseEntry(byRow, page) {
    var visit = byRow.get(page.rowIndex);
    if (!visit) return null;
    try {
      return { visit: visit, note: OPDParse.parseNote(page.html) };
    } catch (e) {
      // One unparseable note is not a reason to lose the rest of the record.
      console.warn("[OPD_diff] row " + page.rowIndex + " did not parse; skipping:", e);
      return null;
    }
  }

  /* The one-shot path: a capture that is already complete. Shared so the overlay,
   * the full-tab viewer and the offline harness all assemble a model the same
   * way -- this was duplicated in three places before. */
  function buildModel(capture) {
    var list = OPDParse.parseList(capture.list.html);
    var byRow = new Map(list.visits.map(function (v) { return [v.rowIndex, v]; }));
    var entries = [];
    (capture.notes || []).forEach(function (raw) {
      var entry = parseEntry(byRow, raw);
      if (entry) entries.push(entry);
    });
    return modelFrom(list.visits, entries, true, list.warnings);
  }

  function create(options) {
    options = options || {};
    var onModel = typeof options.onModel === "function" ? options.onModel : function () {};
    var costFactor = options.costFactor == null ? COST_FACTOR : options.costFactor;
    var minInterval = options.minIntervalMs == null ? MIN_INTERVAL_MS : options.minIntervalMs;
    var schedule = options.schedule || function (fn, ms) { return setTimeout(fn, ms); };
    var unschedule = options.unschedule || function (t) { clearTimeout(t); };

    var visits = [];
    var byRow = new Map();
    var entries = [];
    var listWarnings = [];
    var timer = null;
    var nextAllowedAt = 0;
    var dirty = false;
    var finished = false;
    var current = null;

    function emit(done) {
      var started = clock();
      current = modelFrom(visits, entries.slice(), done, listWarnings);
      dirty = false;
      try {
        onModel(current);
      } catch (e) {
        // A broken view callback must never stop a capture that is already
        // dozens of requests in.
        console.warn("[OPD_diff] onModel threw; continuing:", e);
      }
      // Build AND render: both block the same thread, so both set the pace.
      var cost = clock() - started;
      nextAllowedAt = clock() + Math.max(minInterval, cost * costFactor);
    }

    function pump() {
      timer = null;
      if (!dirty) return;
      var wait = nextAllowedAt - clock();
      if (wait > 0) { timer = schedule(pump, wait); return; }
      emit(false);
    }

    function touch() {
      dirty = true;
      if (timer != null || finished) return;
      timer = schedule(pump, Math.max(0, nextAllowedAt - clock()));
    }

    return {
      /* The visit list, as soon as it is fetched. Emits at once and deliberately
       * ignores the throttle: drawing the whole roster immediately is the single
       * biggest thing that stops a paced read from looking like a hang. */
      setList: function (html) {
        var list = OPDParse.parseList(html);
        visits = list.visits;
        listWarnings = list.warnings;
        byRow = new Map(visits.map(function (v) { return [v.rowIndex, v]; }));
        emit(false);
        return list;
      },

      addNote: function (page) {
        var entry = parseEntry(byRow, page);
        if (!entry) return false;
        entries.push(entry);
        touch();
        return true;
      },

      /* Always rebuilds, throttle or not: the finished view has to be exact. */
      finish: function () {
        finished = true;
        if (timer != null) { unschedule(timer); timer = null; }
        emit(true);
        return current;
      },

      model: function () { return current; },
      loaded: function () { return entries.length; },

      dispose: function () {
        finished = true;
        if (timer != null) { unschedule(timer); timer = null; }
      }
    };
  }

  var api = { create: create, buildModel: buildModel, version: 1 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDStream = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
