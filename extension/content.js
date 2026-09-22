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
 * Everything is mounted inside a SHADOW ROOT. That is not decoration: the HIS
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

  var CHROME_CSS = [
    ":host{all:initial}",
    ".btn{position:fixed;right:16px;bottom:16px;z-index:1;",
    "  font:600 13px/1 system-ui,'Segoe UI','Noto Sans TC',sans-serif;",
    "  padding:10px 14px;border-radius:20px;border:1px solid #1b4f72;",
    "  background:#1b4f72;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}",
    ".btn[disabled]{opacity:.6;cursor:default}",
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

  var panel = null;
  var lastCapture = null;

  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
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
      if (!lastCapture) return;
      tabBtn.disabled = true;
      msg.textContent = "handing over to a new tab…";
      // storage, not a message: a real capture runs past 1.5 MB and that is an
      // awkward thing to post through the extension messaging channel.
      //
      // Mid-read this hands over WHAT HAS BEEN READ SO FAR -- the capture object
      // is the live one, and the new tab is a snapshot of this moment. The read
      // continues in this tab regardless.
      chrome.storage.local.set({ opdCapture: lastCapture }, function () {
        chrome.runtime.sendMessage({ type: "open-viewer" }, function () {
          void chrome.runtime.lastError;
          msg.textContent = "opened in a new tab.";
          tabBtn.disabled = false;
        });
      });
    });

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", closePanel);

    bar.appendChild(name);
    bar.appendChild(msg);
    bar.appendChild(tabBtn);
    bar.appendChild(closeBtn);

    var mount = document.createElement("div");
    mount.className = "mount";

    panel.appendChild(bar);
    panel.appendChild(mount);
    shadow.appendChild(panel);
    return { msg: msg, mount: mount, tabBtn: tabBtn };
  }

  function fail(ui, text) {
    ui.msg.textContent = "";
    var box = document.createElement("div");
    box.className = "err";
    box.textContent = text;
    ui.mount.textContent = "";
    ui.mount.appendChild(box);
  }

  var loading = false;

  /* One capture at a time. The floating button hides itself while the panel is
   * open, but the toolbar button can still fire, and starting a second capture
   * over a running one would double the request rate against a server this
   * project has been careful not to hammer. */
  async function load() {
    if (loading) return;
    loading = true;
    try {
      await loadOnce();
    } finally {
      loading = false;
    }
  }

  async function loadOnce() {
    var histno = currentHistno();
    var ui = openPanel();
    if (!histno) {
      fail(ui, "No patient is open on this page.\n\n" +
               "Open a patient's record first -- OPD_diff reads the chart number " +
               "from the page URL or the histno field.");
      return;
    }

    ui.msg.textContent = "reading visits…";

    var view = null;
    function render(model) {
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
      // mount() once, update() after: the view keeps the reader's selection,
      // tab, filters and scroll position across a rebuild, which it could not
      // do if this tore the panel down and mounted again.
      if (view) view.update(data);
      else view = OPDView.mount(ui.mount, data);
    }

    var stream = OPDStream.create({ onModel: render });

    var capture;
    try {
      capture = await OPDCapture.collect(histno, {
        onList: function (cap) {
          // Held from the first callback, so "Open in tab" works mid-read.
          lastCapture = cap;
          if (OPDCapture.captureFailed(cap)) return;
          ui.tabBtn.disabled = false;
          stream.setList(cap.list.html);
        },
        onNote: function (page, done, total) {
          ui.msg.textContent = "reading visit " + done + " of " + total + "…";
          stream.addNote(page);
        }
      });
    } catch (e) {
      // Partway through is not nothing. If the roster is already on screen,
      // keep what was read and say where it stopped, rather than replacing
      // forty visits with an error box.
      if (view) {
        stream.finish();
        ui.msg.textContent = "stopped early: " + String((e && e.message) || e);
      } else {
        fail(ui, "Could not read this patient.\n\n" + String((e && e.message) || e));
      }
      return;
    }

    if (OPDCapture.captureFailed(capture)) {
      fail(ui, "The server returned no visit-list table.\n\n" +
               "HTTP " + capture.list.status + ", " + capture.list.byteLength + " bytes. " +
               "On web9 this usually means the patient was never selected in the " +
               "session; the capture requests findEmr first, so if you are seeing " +
               "this the page may have logged out.");
      return;
    }

    if (!capture.notes.length) {
      fail(ui, "This patient has no outpatient notes to compare.");
      return;
    }

    var model = stream.finish();
    ui.msg.textContent = capture.notes.length + " visit(s) read";

    if (!model.entries.length) {
      fail(ui, "Read " + capture.notes.length + " note(s), but none of them matched a " +
               "row in the visit list, so there is nothing to line up.");
    }
  }

  button.addEventListener("click", function () { load(); });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "toggle-overlay") {
      if (panel) closePanel(); else load();
    }
  });
})();
