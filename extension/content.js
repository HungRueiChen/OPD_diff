/* OPD_diff -- in-page overlay.
 *
 * Adds a floating button to qemr pages. Clicking it reads whichever patient is
 * currently open, builds the copy-forward lineage and course, and mounts the
 * same OPDView the offline harness uses.
 *
 * The panel fills in AS THE CAPTURE ARRIVES rather than after it finishes. The
 * visit list comes back in one request, so the whole roster is on screen almost
 * immediately; notes then arrive newest first and the view re-renders on a
 * throttle (see opd_stream.js, which owns that pacing). A clinician gets a
 * usable comparison of the two most recent visits within a few seconds of a read
 * that may take two minutes to complete.
 *
 * "Open in tab" hands the SAME READ over to a full tab, live. This page stays
 * the only thing talking to the HIS -- the viewer tab never issues a request of
 * its own -- so opening it does not double the request rate against a server
 * this project has been careful not to hammer. The handover works by publishing
 * each note into chrome.storage.local as it lands; the viewer subscribes. See
 * publish() below for why it is one key per note rather than one blob.
 *
 * Once a read exists, the note the HIS itself shows is also coloured in place
 * ("inline blame", src/opd_inline.js). That is the one thing that draws on the
 * record rather than beside it, so it wraps text without changing any, matches
 * the note by content rather than by date/clinic/doctor, and can be switched
 * off from a floating toggle.
 *
 * The panel itself is mounted inside a SHADOW ROOT. That is not decoration: the HIS
 * ships its own global CSS (jQuery UI, thickbox, a 2009-era Master.css) and
 * OPDView injects its own stylesheet. Without isolation they bleed into each
 * other in both directions -- and a tool that restyles the medical record it is
 * sitting on top of would be worse than no tool.
 *
 * Nothing is de-identified here and nothing leaves the machine. This runs on the
 * hospital workstation, against the session already open in the browser, and
 * reads the same pages the clinician can already see.
 */
(function () {
  "use strict";

  if (window.__OPD_DIFF_OVERLAY__) return;
  window.__OPD_DIFF_OVERLAY__ = true;

  /* The old pattern was /[?&]histno=(\d{4,10})(?!\d)/ and it silently truncated.
   * A hyphen SATISFIES (?!\d), so a hyphenated chart number lost its final check
   * digit -- and since chart numbers here run 4 to 8 digits, what remained was
   * not an obviously broken value but another valid one, potentially a different
   * patient's. The lookahead now rejects a trailing hyphen as well, and the
   * capture module owns the actual normalising so every entry point shares one
   * rule. (No literal example here: it is the shape deid.py's chart rule
   * matches, and it would make this file trip the guard.) */
  var HISTNO_IN_URL = /[?&]histno=(\d{3,10}(?:-\d)?)(?![\d-])/;

  /* The chart number of the patient on screen. The URL is authoritative when it
   * carries one; otherwise the search form on the page holds it. */
  function currentHistno() {
    var m = HISTNO_IN_URL.exec(location.href);
    if (m) {
      var fromUrl = OPDCapture.normalizeHistno(m[1]);
      if (fromUrl) return fromUrl;
    }
    var input = document.querySelector("input[name=histno], input#histno");
    return OPDCapture.normalizeHistno(input ? input.value : null);
  }

  // ------------------------------------------------------------- handover
  //
  // One key per note, written once, rather than one key holding the whole
  // capture rewritten on every update. A long record runs to several megabytes,
  // chrome.storage.local is quota'd, and rewriting that blob every couple of
  // seconds for two minutes would churn hard enough to be felt -- while a quota
  // failure would look exactly like success, which is the same silent-failure
  // shape this project has already been bitten by in the HIS itself.
  //
  // Nothing is published until the reader actually asks for a tab, so a read
  // that stays in the overlay costs no storage at all.

  var NOTE_PREFIX = "opdNote:";
  var BATCH = 25;

  // A random token, not a timestamp: a date literal in a key is the shape
  // deid.py matches, and the viewer only needs to tell one read from the next.
  var sessionId = null;
  var liveCapture = null;
  var publishing = false;

  function noteKey(rowIndex) { return NOTE_PREFIX + sessionId + ":" + rowIndex; }

  function setLocal(obj, done) {
    chrome.storage.local.set(obj, function () {
      var err = chrome.runtime.lastError;
      if (done) done(err || null);
      else if (err) console.warn("[OPD_diff] storage write failed:", err.message);
    });
  }

  /* Drop everything a previous read left behind, so two patients can never be
   * mixed in one viewer and so the quota is not slowly eaten by old captures. */
  function clearPublished(done) {
    chrome.storage.local.get(null, function (all) {
      var drop = Object.keys(all || {}).filter(function (k) {
        return k === "opdCapture" || k === "opdStatus" || k.indexOf(NOTE_PREFIX) === 0;
      });
      if (!drop.length) return done();
      chrome.storage.local.remove(drop, function () {
        void chrome.runtime.lastError;
        done();
      });
    });
  }

  function statusRecord(capture, done) {
    return {
      session: sessionId,
      loaded: capture.notes.length,
      total: capture.rowsTotal || capture.notes.length,
      done: Boolean(done)
    };
  }

  function writeNotes(notes, done) {
    var at = 0;
    (function step() {
      if (at >= notes.length) return done(null);
      var batch = {};
      for (var n = 0; n < BATCH && at < notes.length; n++, at++) {
        batch[noteKey(notes[at].rowIndex)] = notes[at];
      }
      setLocal(batch, function (err) {
        if (err) return done(err);
        step();
      });
    })();
  }

  /* Publish what has been read so far, then let onNote keep the tab fed. The
   * visit list goes over on its own so the viewer can draw the whole roster
   * immediately, exactly as this panel does -- including when the tab is opened
   * before a single note has arrived. */
  function publish(capture, finished, done) {
    clearPublished(function () {
      var meta = {
        session: sessionId,
        origin: capture.origin,
        list: capture.list,
        rowsTotal: capture.rowsTotal
      };
      setLocal({ opdCapture: meta }, function (err) {
        if (err) return done(err);
        writeNotes(capture.notes, function (err2) {
          if (err2) return done(err2);
          // A read served from memory is already finished, and the tab must be
          // told so, or it would say "still reading" about a read that ended.
          setLocal({ opdStatus: statusRecord(capture, finished) }, done);
        });
      });
    });
  }

  var CHROME_CSS = [
    ":host{all:initial}",
    ".btn{position:fixed;right:16px;bottom:16px;z-index:1;",
    "  font:600 13px/1 system-ui,'Segoe UI','Noto Sans TC',sans-serif;",
    "  padding:10px 14px;border-radius:20px;border:1px solid #1b4f72;",
    "  background:#1b4f72;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}",
    ".btn[disabled]{opacity:.6;cursor:default}",
    ".pill{position:fixed;right:120px;bottom:16px;z-index:1;",
    "  font:600 12px/1 system-ui,'Segoe UI','Noto Sans TC',sans-serif;",
    "  padding:10px 12px;border-radius:20px;border:1px solid #1b4f72;",
    "  background:#fff;color:#1b4f72;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}",
    ".pill[aria-pressed=true]{background:#eaf2f8}",
    ".panel{position:fixed;inset:24px;z-index:2;display:flex;flex-direction:column;",
    "  background:#fff;border:1px solid #d7dde3;border-radius:10px;overflow:hidden;",
    "  box-shadow:0 8px 40px rgba(0,0,0,.35);",
    "  font:14px/1.55 system-ui,'Segoe UI','Noto Sans TC',sans-serif;color:#1b1f24}",
    ".bar{display:flex;gap:10px;align-items:center;padding:8px 12px;",
    "  border-bottom:1px solid #e6eaee;background:#f8fafc;flex:none}",
    ".bar .name{font-weight:600}",
    ".bar .msg{color:#5b6672;font-size:13px;flex:1;min-width:0;",
    "  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".bar button{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;",
    "  border:1px solid #c7d0d9;background:#fff;cursor:pointer}",
    ".mount{flex:1;min-height:0}",
    ".err{padding:20px;color:#922b21;white-space:pre-wrap}",
  ].join("\n");

  var host = document.createElement("div");
  host.id = "opd-diff-overlay";
  // The HIS uses large z-indexes of its own for its modals.
  host.style.cssText = "position:fixed;inset:0;width:0;height:0;z-index:2147483647";
  document.documentElement.appendChild(host);

  var shadow = host.attachShadow({ mode: "open" });
  var style = document.createElement("style");
  style.textContent = CHROME_CSS;
  shadow.appendChild(style);

  var button = document.createElement("button");
  button.className = "btn";
  button.textContent = "OPD_diff";
  shadow.appendChild(button);

  // ---------------------------------------------------------- inline blame
  //
  // Colours the note the HIS itself is showing (in its #opddetail box) by the
  // visit that first wrote each line; see src/opd_inline.js for the rules that
  // govern drawing on the record. What this part adds:
  //
  //   * It only ever uses a read the clinician started, for the patient still
  //     on screen. Nothing here fetches anything.
  //   * The HIS swaps notes into #opddetail with its own script, so a
  //   MutationObserver notices each new note. The observer is disconnected
  //     while we decorate, so our own edits cannot retrigger it.
  //   * One click turns it off, and that choice is remembered.

  var inlineOn = true;
  var latestModel = null;
  var readHistno = null;
  var modelStamp = 0;
  var inlineTimer = null;
  var observer = null;

  var pill = document.createElement("button");
  pill.className = "pill";
  pill.hidden = true;
  shadow.appendChild(pill);

  function inlineActive() {
    return Boolean(inlineOn && latestModel && readHistno && currentHistno() === readHistno);
  }

  function refreshPill() {
    pill.hidden = !(latestModel && readHistno && currentHistno() === readHistno);
    pill.textContent = "Inline blame: " + (inlineOn ? "on" : "off");
    pill.setAttribute("aria-pressed", String(inlineOn));
    pill.title = inlineOn
      ? "Notes shown by the HIS are coloured by the visit that first wrote each line. Click to turn off."
      : "Click to colour notes shown by the HIS by the visit that first wrote each line.";
  }

  function watch() {
    if (observer) observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function applyInline() {
    if (typeof OPDInline === "undefined") return;
    if (observer) observer.disconnect();
    try {
      if (!inlineActive()) {
        OPDInline.undecorate(document);
      } else {
        OPDInline.findNoteFieldsets(document).forEach(function (fs) {
          if (OPDInline.stampOf(fs) === String(modelStamp)) return;
          try {
            OPDInline.decorate(fs, latestModel, { stamp: modelStamp });
          } catch (e) {
            // A failure must leave the record exactly as the HIS drew it.
            console.warn("[OPD_diff] inline blame failed; note left as it was:", e);
            OPDInline.undecorate(fs);
          }
        });
      }
    } finally {
      watch();
    }
    refreshPill();
  }

  function scheduleInline() {
    if (inlineTimer) return;
    inlineTimer = setTimeout(function () { inlineTimer = null; applyInline(); }, 60);
  }

  /* Started on the first read, not at page load: until a clinician asks for a
   * read there is nothing to draw, and no reason to watch the HIS's DOM. */
  function ensureObserver() {
    if (observer || typeof MutationObserver === "undefined") return;
    observer = new MutationObserver(scheduleInline);
    watch();
  }

  function setInlineModel(model, histno) {
    latestModel = model;
    readHistno = histno;
    modelStamp++;
    ensureObserver();
    scheduleInline();
  }

  pill.addEventListener("click", function () {
    inlineOn = !inlineOn;
    try { chrome.storage.local.set({ opdInlineBlame: inlineOn }); } catch (e) { /* preference only */ }
    if (typeof OPDInline !== "undefined") OPDInline.undecorate(document);
    applyInline();
  });

  try {
    chrome.storage.local.get("opdInlineBlame", function (res) {
      void chrome.runtime.lastError;
      if (res && res.opdInlineBlame === false) inlineOn = false;
      refreshPill();
    });
  } catch (e) { /* default stays on */ }

  // ------------------------------------------------------------- the read
  //
  // One read per patient, held in memory for as long as this HIS page stays
  // loaded. The HIS swaps visits and notes into this same page with its own
  // script, so the page -- and this content script with it -- lives through a
  // whole consultation. Reading again on every click would spend a minute or two
  // of paced requests to fetch notes already in hand.
  //
  // The read is therefore decoupled from the panel. The panel is only a window
  // onto it: close it and the read carries on; open it again and it shows
  // whatever the read has reached, finished or not.
  //
  //   same patient, read finished    -> shown from memory, no request at all
  //   same patient, read running     -> the panel joins it; no second read
  //   another patient                -> a new read; the old one stops before
  //                                     its next request
  //   last read failed or stopped    -> read again
  //
  // A read held in memory does NOT see a note written after it was taken --
  // today's note, typically, if the panel was first opened before the
  // consultation. So the bar says when the read was taken, and "Re-read" forces
  // a fresh one.

  var read = null;
  var panel = null;
  var ui = null;
  var view = null;

  function clock(date) {
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(date.getHours()) + ":" + two(date.getMinutes());
  }

  function setMsg(r, text) {
    r.message = text;
    if (ui && read === r) ui.msg.textContent = text;
  }

  function renderPanel() {
    if (!ui || !read || !read.model || read.failed) return;
    var model = read.model;
    var data = {
      caseName: "chart on screen",
      visits: model.visits,
      entries: model.entries,
      lineage: model.lineage,
      course: model.course,
      loaded: model.loaded,
      total: model.total,
      done: model.done
    };
    // mount() once per panel, update() after: the view keeps the reader's
    // selection, tab, filters and scroll position across a rebuild.
    if (view) view.update(data);
    else view = OPDView.mount(ui.mount, data);
  }

  function refreshPanel() {
    if (!ui) return;
    if (!read) return;
    ui.msg.textContent = read.message || "";
    ui.tabBtn.disabled = !(read.capture && !OPDCapture.captureFailed(read.capture) && !read.failed);
    // Never two reads at once: re-reading waits for the running one to end.
    ui.rereadBtn.disabled = !(read.done || read.failed);
    if (read.failed) fail(ui, read.error);
    else renderPanel();
  }

  async function startRead(histno) {
    var r = {
      histno: histno, stream: null, capture: null, model: null,
      done: false, failed: false, partial: false, error: null,
      message: "reading visits…", readAt: null
    };
    read = r;
    view = null;
    if (ui) ui.mount.textContent = "";

    sessionId = Math.random().toString(36).slice(2, 10);
    liveCapture = null;
    publishing = false;
    // A new read supersedes the old one: strip its colouring at once rather
    // than leave a previous read's attribution on the page.
    setInlineModel(null, histno);

    r.stream = OPDStream.create({
      onModel: function (model) {
        if (read !== r) return;
        r.model = model;
        renderPanel();
        // The same model colours the HIS's own note, inline, as it arrives.
        setInlineModel(model, histno);
      }
    });
    refreshPanel();

    var capture;
    try {
      capture = await OPDCapture.collect(histno, {
        shouldStop: function () { return read !== r; },
        onList: function (cap) {
          if (read !== r) return;
          r.capture = cap;
          liveCapture = cap;
          if (OPDCapture.captureFailed(cap)) return;
          r.stream.setList(cap.list.html);
          refreshPanel();
        },
        onNote: function (page, done, total) {
          if (read !== r) return;
          setMsg(r, "reading visit " + done + " of " + total + "…");
          r.stream.addNote(page);
          if (publishing) {
            var batch = {};
            batch[noteKey(page.rowIndex)] = page;
            batch.opdStatus = statusRecord(liveCapture, false);
            setLocal(batch);
          }
        }
      });
    } catch (e) {
      if (read !== r) return;
      if (publishing && liveCapture) setLocal({ opdStatus: statusRecord(liveCapture, true) });
      // Partway through is not nothing. Keep what was read and say where it
      // stopped -- but mark it partial, so the next click reads again rather
      // than serving an incomplete record from memory as if it were whole.
      if (r.model) {
        r.stream.finish();
        r.done = true;
        r.partial = true;
        setMsg(r, "stopped early: " + String((e && e.message) || e) + " — Re-read to try again");
      } else {
        r.failed = true;
        r.error = "Could not read this patient.\n\n" + String((e && e.message) || e);
      }
      refreshPanel();
      return;
    }
    if (read !== r) return;

    if (OPDCapture.captureFailed(capture)) {
      r.failed = true;
      r.error = "The server returned no visit-list table.\n\n" +
        "HTTP " + capture.list.status + ", " + capture.list.byteLength + " bytes. " +
        "On web9 this usually means the patient was never selected in the " +
        "session; the capture requests findEmr first, so if you are seeing " +
        "this the page may have logged out.";
      refreshPanel();
      return;
    }
    if (!capture.notes.length) {
      r.failed = true;
      r.error = "This patient has no outpatient notes to compare.";
      refreshPanel();
      return;
    }

    var model = r.stream.finish();
    r.done = true;
    r.readAt = new Date();
    // Tells the viewer to stop saying "still reading" and settle its colours.
    if (publishing) setLocal({ opdStatus: statusRecord(capture, true) });

    if (!model.entries.length) {
      r.failed = true;
      r.error = "Read " + capture.notes.length + " note(s), but none of them matched a " +
        "row in the visit list, so there is nothing to line up.";
    } else {
      setMsg(r, capture.notes.length + " visit(s) read at " + clock(r.readAt) +
                " · kept in memory — Re-read for notes written since");
    }
    refreshPanel();
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    ui = null;
    view = null;
    button.style.display = "";
  }

  function openPanel() {
    closePanel();
    button.style.display = "none";
    panel = document.createElement("div");
    panel.className = "panel";

    var bar = document.createElement("div");
    bar.className = "bar";

    var name = document.createElement("span");
    name.className = "name";
    name.textContent = "OPD_diff";

    var msg = document.createElement("span");
    msg.className = "msg";

    var tabBtn = document.createElement("button");
    tabBtn.textContent = "Open in tab";
    tabBtn.disabled = true;
    tabBtn.addEventListener("click", function () {
      if (!liveCapture || !read) return;
      var r = read;
      tabBtn.disabled = true;
      msg.textContent = "handing over to a new tab…";
      // Set BEFORE publishing, not after. publish() is several asynchronous
      // storage writes long, and a note arriving in the middle of it would
      // otherwise fall between the snapshot and the live feed and reach the tab
      // never. Writing one note twice is harmless; missing one is not.
      publishing = true;
      publish(liveCapture, r.done, function (err) {
        if (err) {
          // Loud, not silent. A failed write here would otherwise leave a tab
          // that simply never fills in, with nothing anywhere saying why.
          publishing = false;
          msg.textContent = "could not hand over: " + err.message;
          tabBtn.disabled = false;
          return;
        }
        chrome.runtime.sendMessage({ type: "open-viewer" }, function () {
          void chrome.runtime.lastError;
          msg.textContent = r.done ? "opened in a new tab."
                                   : "following in a new tab — keep this tab open.";
          tabBtn.disabled = false;
        });
      });
    });

    var rereadBtn = document.createElement("button");
    rereadBtn.textContent = "Re-read";
    rereadBtn.disabled = true;
    rereadBtn.title = "Fetch every visit again, for notes written since this read was taken.";
    rereadBtn.addEventListener("click", function () {
      if (!read || !(read.done || read.failed)) return;
      startRead(read.histno);
    });

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closePanel);

    bar.appendChild(name);
    bar.appendChild(msg);
    bar.appendChild(tabBtn);
    bar.appendChild(rereadBtn);
    bar.appendChild(closeBtn);

    var mount = document.createElement("div");
    mount.className = "mount";

    panel.appendChild(bar);
    panel.appendChild(mount);
    shadow.appendChild(panel);
    ui = { msg: msg, mount: mount, tabBtn: tabBtn, rereadBtn: rereadBtn };
    return ui;
  }

  function fail(target, text) {
    view = null;
    target.msg.textContent = "";
    var box = document.createElement("div");
    box.className = "err";
    box.textContent = text;
    target.mount.textContent = "";
    target.mount.appendChild(box);
  }

  function showPanel() {
    var histno = currentHistno();
    openPanel();
    if (!histno) {
      fail(ui, "No patient is open on this page.\n\n" +
               "Open a patient's record first -- OPD_diff reads the chart number " +
               "from the page URL or the histno field.");
      return;
    }
    var reuse = read && read.histno === histno && !read.failed && !read.partial;
    if (reuse) refreshPanel();
    else startRead(histno);
  }

  button.addEventListener("click", showPanel);

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "toggle-overlay") {
      if (panel) closePanel(); else showPanel();
    }
  });
})();
