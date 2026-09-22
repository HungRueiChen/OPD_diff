/* OPD_diff -- full-tab viewer.
 *
 * Reads the capture the overlay left in chrome.storage.local and mounts the same
 * OPDView. This page never talks to the HIS: it has no session and needs none,
 * because the content script already fetched everything in the authenticated
 * page. That also means opening this tab directly, without going through the
 * overlay first, correctly shows nothing.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var status = document.getElementById("status");

  function show(text) {
    status.hidden = false;
    status.textContent = text;
  }

  /* Assembly lives in opd_stream.js now, shared with the overlay and the offline
   * harness. It was duplicated in three places, and a capture handed over
   * mid-read has to be assembled by exactly the same code that was rendering it
   * in the other tab a moment earlier. */
  function buildModel(capture) {
    return OPDStream.buildModel(capture);
  }

  chrome.storage.local.get("opdCapture", function (res) {
    var capture = res && res.opdCapture;
    if (!capture || !capture.notes || !capture.notes.length) {
      show("Nothing to show yet.\n\n" +
           "Open a patient in the HIS, click the OPD_diff button in the corner of " +
           "the page, then choose \"Open in tab\".");
      return;
    }

    var model;
    try {
      model = buildModel(capture);
    } catch (e) {
      show("Could not parse the captured visits.\n\n" + String((e && e.stack) || e));
      return;
    }

    if (!model.entries.length) {
      show("The capture holds " + capture.notes.length + " note(s), but none of them " +
           "matched a row in the visit list, so there is nothing to line up.");
      return;
    }

    try {
      OPDView.mount(app, {
        caseName: model.entries.length + " visits",
        entries: model.entries,
        lineage: model.lineage,
        course: model.course
      });
      document.title = "OPD_diff — " + model.entries.length + " visits";
    } catch (e) {
      show("Could not render.\n\n" + String((e && e.stack) || e));
    }
  });
})();
