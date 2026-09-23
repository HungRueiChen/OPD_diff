/* OPD_diff -- full-tab viewer.
 *
 * Follows the read happening in the HIS tab, live. The content script publishes
 * the visit list and then each note into chrome.storage.local as it lands; this
 * page subscribes and re-renders on the same throttle the overlay uses.
 *
 * This page NEVER talks to the HIS. It has no session and needs none, and more
 * to the point it must not: the overlay is already fetching, and a second reader
 * would double the request rate against a server that blocks IPs for abnormal
 * activity. Everything here comes from storage. That also means opening this
 * page directly, without going through the overlay, correctly shows nothing.
 *
 * Closing or navigating the HIS tab stops the read -- the content script dies
 * with it -- and this page simply stops receiving notes.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var status = document.getElementById("status");

  function show(text) {
    status.hidden = false;
    status.textContent = text;
  }

  // A folder copied to a ward machine before opd_stream.js existed would fail
  // here with a bare ReferenceError in a console nobody has open. Say it plainly
  // instead, and name the fix.
  if (typeof OPDStream === "undefined" || typeof OPDView === "undefined") {
    show("This page is missing part of the extension.\n\n" +
         "Copy the whole extension folder again, then press Reload on its card " +
         "in chrome://extensions — the browser caches file contents, so a newly " +
         "copied file is not picked up without it.");
    return;
  }

  var NOTE_PREFIX = "opdNote:";

  var view = null;
  var stream = null;
  var session = null;
  var seen = Object.create(null);
  var settled = false;

  function render(model) {
    var data = {
      caseName: "full record",
      visits: model.visits,
      entries: model.entries,
      lineage: model.lineage,
      course: model.course,
      loaded: model.loaded,
      total: model.total,
      done: model.done
    };
    if (view) {
      view.update(data);
    } else {
      status.hidden = true;
      view = OPDView.mount(app, data);
    }
    // No chart number in the title: a tab title is visible in window lists,
    // screenshots and session restores.
    document.title = "OPD_diff — " + model.loaded +
      (model.done ? "" : " of " + (model.total || "?")) + " visits";
  }

  function prefix() { return NOTE_PREFIX + session + ":"; }

  /* Order does not matter -- OPDLineage.build sorts chronologically itself --
   * but the row index does, because it is what joins a note to its visit. */
  function absorb(all) {
    var added = false;
    Object.keys(all || {}).forEach(function (key) {
      if (key.indexOf(prefix()) !== 0 || seen[key]) return;
      var page = all[key];
      if (!page) return;
      seen[key] = true;
      if (stream.addNote(page)) added = true;
    });
    return added;
  }

  chrome.storage.local.get(null, function (all) {
    var err = chrome.runtime.lastError;
    if (err) {
      show("Could not read the handover.\n\n" + err.message);
      return;
    }
    var meta = all && all.opdCapture;
    if (!meta || !meta.list || !meta.list.html) {
      show("Nothing to show yet.\n\n" +
           "Open a patient in the HIS, click the OPD_diff button in the corner of " +
           "the page, then choose \"Open in tab\".");
      return;
    }

    session = meta.session;
    try {
      stream = OPDStream.create({ onModel: render });
      stream.setList(meta.list.html);
      absorb(all);
      var st = all.opdStatus;
      if (st && st.done) { settled = true; stream.finish(); }
    } catch (e) {
      show("Could not assemble the captured visits.\n\n" + String((e && e.stack) || e));
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !stream) return;

    /* Checked BEFORE the settled guard, deliberately.
     *
     * A different session means a new patient is being read in the HIS tab. A
     * viewer that had finished its own read would otherwise ignore this and sit
     * there showing the PREVIOUS patient, under a title that looks identical to
     * the new one's and carries no chart number to tell them apart. Showing one
     * patient's notes under another patient's roster is the worst failure this
     * tool could have, so it starts over instead. */
    if (changes.opdCapture && changes.opdCapture.newValue &&
        changes.opdCapture.newValue.session !== session) {
      location.reload();
      return;
    }
    if (settled) return;

    var arrived = {};
    var any = false;
    Object.keys(changes).forEach(function (key) {
      if (key.indexOf(prefix()) !== 0) return;
      var page = changes[key].newValue;
      if (!page) return;
      arrived[key] = page;
      any = true;
    });
    if (any) absorb(arrived);

    var st = changes.opdStatus && changes.opdStatus.newValue;
    if (st && st.done) {
      settled = true;
      stream.finish();
    }
  });
})();
