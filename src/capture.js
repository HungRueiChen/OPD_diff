/* OPD_diff -- fixture capture. READ-ONLY: issues GETs only, never writes to the HIS.
 *
 * Run this in DevTools on any authenticated HIS page (web9 or rkeprd). It walks the
 * OPD visit list for one chart number, fetches each note, and downloads a single
 * JSON file of RAW payloads.
 *
 * It deliberately parses almost nothing. Every cell of every row is captured
 * verbatim so the column layout, date format, href shape and charset can all be
 * settled offline -- a wrong guess here would otherwise cost another VM session.
 *
 * Target: Chrome/Edge 109 (last version supporting Win7). No top-level await,
 * no CSS nesting, no syntax past ES2022.
 *
 *   OPDCapture.run("<chart number>")              // every visit, no cap
 *   OPDCapture.run("<chart number>", { max: 5 })  // fewer, while testing
 */
(function () {
  "use strict";

  // The HIS answers on more than one host -- the older scraper targets web9, the
  // saved example came from rkeprd -- and links are absolute to whichever served
  // the page. Take the origin from wherever this is actually running.
  var KNOWN_HOSTS = ["web9.vghtpe.gov.tw", "rkeprd.vghtpe.gov.tw"];
  var ROOT = location.origin + "/";
  var QEMR = ROOT + "emr/qemr/qemr.cfm";

  // The HIS is a legacy ColdFusion app and some pages are served as Big5 with no
  // charset header. Guessing wrong silently mangles every Chinese character, so
  // record which decoder was actually used for each page.
  var FALLBACK_CHARSETS = ["big5", "utf-8"];

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Jittered, sequential. The README warns that too many requests gets the IP
  // blocked by 資訊室, so this never runs in parallel.
  function politeDelay() {
    return sleep(400 + Math.random() * 600);
  }

  /* One chart number, in canonical form -- or null.
   *
   * The HIS writes the same patient both as nnnnnnnn and as nnnnnnn-n: the last
   * digit is a check digit and either form links to the right record.
   *
   * Chart numbers here run 4 to 8 digits, and THAT is what makes the hyphen
   * dangerous. Dropping the check digit does not yield an obviously broken
   * value; it yields another number of entirely valid length, which may belong
   * to a different patient. A tool that silently opens the wrong record is worse
   * than one that refuses, so this returns null rather than guess, and every
   * caller treats null as a hard error.
   *
   * The range stays 4-10 rather than narrowing to the 4-8 seen so far: rejecting
   * a real chart number breaks the tool for that patient, while accepting an
   * over-long one merely fails at the server.
   *
   * (Digits are written as n on purpose. A literal example of either form is
   * exactly what deid.py's chart rules match, and it would make this file trip
   * the guard and become unreadable to every tool that names it.) */
  function normalizeHistno(value) {
    var s = String(value == null ? "" : value).trim();
    if (/^\d{4,10}$/.test(s)) return s;
    var m = /^(\d{3,9})-(\d)$/.exec(s);
    return m ? m[1] + m[2] : null;
  }

  function charsetFromHeader(res) {
    var ct = res.headers.get("content-type") || "";
    var m = /charset=\s*"?([\w-]+)/i.exec(ct);
    return m ? m[1].toLowerCase() : null;
  }

  function charsetFromMeta(bytes) {
    // Pre-decode as latin1 so the meta tag is readable whatever the real charset.
    var head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
    var m = /<meta[^>]+charset=\s*"?([\w-]+)/i.exec(head);
    return m ? m[1].toLowerCase() : null;
  }

  function decode(bytes, label) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  async function getPage(url) {
    // "include", not "same-origin". Pasted into a console these are the same
    // thing, but inside an MV3 content script the request is issued with the
    // EXTENSION's origin, so "same-origin" would attach no HIS session cookie
    // and every page would come back as a login screen. host_permissions in the
    // manifest is what makes the credentialed request legal.
    var res = await fetch(url, { credentials: "include", redirect: "follow" });
    var buf = new Uint8Array(await res.arrayBuffer());

    var tried = [];
    var candidates = [charsetFromHeader(res), charsetFromMeta(buf)]
      .concat(FALLBACK_CHARSETS);

    for (var i = 0; i < candidates.length; i++) {
      var label = candidates[i];
      if (!label || tried.indexOf(label) !== -1) continue;
      tried.push(label);
      var text = decode(buf, label);
      if (text !== null) {
        return {
          url: url,
          status: res.status,
          finalUrl: res.url,
          charset: label,
          charsetTried: tried,
          byteLength: buf.length,
          html: text
        };
      }
    }
    // Nothing decoded cleanly. Keep it as latin1 so no byte is lost.
    return {
      url: url,
      status: res.status,
      finalUrl: res.url,
      charset: "latin1-fallback",
      charsetTried: tried,
      byteLength: buf.length,
      html: new TextDecoder("latin1").decode(buf)
    };
  }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Some hrefs in this app are plain relative URLs, others are wrapped in a JS
  // call such as  javascript:openWin('emr/...')  -- capture both readings and let
  // the offline parser decide.
  function hrefCandidates(raw) {
    var out = [];
    if (!raw) return out;
    out.push(raw);
    var inner = /\(\s*['"]([^'"]+)['"]/.exec(raw);
    if (inner) out.push(inner[1]);
    return out;
  }

  function absolute(href) {
    try {
      return new URL(href, ROOT).href;
    } catch (e) {
      return null;
    }
  }

  function captureRows(doc) {
    var body = doc.querySelector("tbody#list") || doc.querySelector("table tbody");
    if (!body) return { found: false, rows: [] };

    var rows = [];
    var trs = body.querySelectorAll("tr");
    for (var i = 0; i < trs.length; i++) {
      var tds = trs[i].querySelectorAll("td");
      var cells = [];
      for (var j = 0; j < tds.length; j++) {
        cells.push(tds[j].textContent.replace(/ /g, " ").trim());
      }
      var links = [];
      var anchors = trs[i].querySelectorAll("a");
      for (var k = 0; k < anchors.length; k++) {
        links.push({
          cellIndex: indexOfCell(tds, anchors[k]),
          text: anchors[k].textContent.trim(),
          title: anchors[k].getAttribute("title"),
          rawHref: anchors[k].getAttribute("href"),
          onclick: anchors[k].getAttribute("onclick")
        });
      }
      rows.push({
        rowIndex: i,
        cellCount: cells.length,
        cells: cells,
        links: links,
        // A visit is keyed by (dt, dept, doc), NOT by date: the same patient can
        // have two clinics on one day in different departments.
        visitKey: visitKeyFromRow(links)
      });
    }
    return { found: true, selector: body.id ? "tbody#" + body.id : "table tbody", rows: rows };
  }

  function indexOfCell(tds, node) {
    for (var i = 0; i < tds.length; i++) {
      if (tds[i].contains(node)) return i;
    }
    return -1;
  }

  // Each visit row carries two links: the date cell (title="opddetail", the SOAP
  // note) and a PDF export. Never follow the PDF -- it is a binary download, and
  // clicking it in a loop would pull 50 files into the browser.
  function noteUrlForRow(row) {
    var ranked = row.links.slice().sort(function (a, b) {
      return (b.title === "opddetail") - (a.title === "opddetail");
    });
    for (var i = 0; i < ranked.length; i++) {
      var cands = hrefCandidates(ranked[i].rawHref)
        .concat(hrefCandidates(ranked[i].onclick));
      for (var j = 0; j < cands.length; j++) {
        var c = cands[j];
        if (!c || /^javascript:\s*(void|;|$)/i.test(c)) continue;
        var abs = absolute(c.replace(/^javascript:[^(]*\(?\s*['"]?/, ""));
        if (!abs || abs.indexOf(ROOT) !== 0) continue;
        if (/pdf\.cfm/i.test(abs)) continue;
        return abs;
      }
    }
    return null;
  }

  function visitKeyFromRow(links) {
    for (var i = 0; i < links.length; i++) {
      var href = links[i].rawHref;
      if (!href || !/action=findOpd/i.test(href)) continue;
      var u = absolute(href);
      if (!u) continue;
      var q = new URL(u).searchParams;
      return {
        dt: q.get("dt"),
        dept: q.get("dept"),
        doc: q.get("doc"),
        deptnm: q.get("deptnm")
      };
    }
    return null;
  }

  function download(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* Fetch one patient and return the capture. Writes nothing.
   *
   * Split out of run() so the browser extension can render in place: it has no
   * business dropping JSON files into the user's Downloads folder. run() is now
   * collect() plus the download, so the console-paste workflow is unchanged. */
  async function collect(histno, options) {
    options = options || {};
    // Every visit, uncapped. The list is newest-first, so ANY limit silently
    // drops the OLDEST history -- usually the diagnosis and the first treatment,
    // which a course summary needs most. Measured on one ward: a 40-visit cap
    // took 1439 of 2472 available visits, and one patient alone had 221.
    // Pass { max: n } deliberately for a short test run.
    var max = options.max == null ? Infinity : options.max;

    // Canonicalise once, here, and reassign: every URL built below, and the
    // histno recorded in the capture, then follow from a single decision. The
    // old guard accepted a truncated value without complaint.
    var chart = normalizeHistno(histno);
    if (!chart) {
      throw new Error("run(histno): expected 4-10 digits, optionally with the final " +
                      "check digit separated by a hyphen; got " +
                      JSON.stringify(String(histno)));
    }
    histno = chart;
    if (KNOWN_HOSTS.indexOf(location.host) === -1) {
      console.warn("[OPD_diff] Host " + location.host + " is not a known HIS host " +
                   "(" + KNOWN_HOSTS.join(", ") + "). Continuing against " + ROOT +
                   " -- cross-origin fetches will fail if this is the wrong page.");
    }

    var capture = {
      tool: "OPD_diff/capture.js",
      formatVersion: 1,
      capturedAt: new Date().toISOString(),
      histno: String(histno),
      origin: location.origin,
      pageCharset: document.characterSet,
      userAgent: navigator.userAgent,
      context: null,
      list: null,
      rowSurvey: null,
      notes: [],
      errors: []
    };

    // Select the patient BEFORE asking for their visit list.
    //
    // web9 keeps patient context in the server session. A bare findOpd there
    // answers HTTP 200 with an Error.jsp body reading 尚未選擇病患 -- "no patient
    // has been selected yet" -- so fetch() raises nothing and the capture comes
    // back empty. The clinician flow sets that context first: every 查 link on a
    // ward roster points at action=findEmr&histno=..., never at findOpd.
    //
    // rkeprd tolerated jumping straight to findOpd (50 of 50 captures worked);
    // web9 refused it 12 times out of 12, all with the same 776-byte body. One
    // extra GET per patient mirrors what a human does and costs nothing on
    // either host.
    var contextUrl = QEMR + "?action=findEmr&histno=" + encodeURIComponent(histno);
    console.log("[OPD_diff] selecting patient:", contextUrl);
    var context = await getPage(contextUrl);
    capture.context = {
      url: context.url,
      finalUrl: context.finalUrl,
      status: context.status,
      charset: context.charset,
      byteLength: context.byteLength,
      // A real EMR page is tens of kB; an error page is under 1 kB. Keep the
      // body only when it is small enough to be an error worth reading, so a
      // failure stays diagnosable offline without doubling every capture.
      html: (context.byteLength != null && context.byteLength < 8192) ? context.html : null
    };
    await politeDelay();

    var listUrl = QEMR + "?action=findOpd&histno=" + encodeURIComponent(histno);
    console.log("[OPD_diff] visit list:", listUrl);
    capture.list = await getPage(listUrl);

    var doc = parseDoc(capture.list.html);
    capture.rowSurvey = captureRows(doc);
    if (!capture.rowSurvey.found) {
      console.error("[OPD_diff] No visit-list table found. Saving the raw page " +
                    "anyway so the selector can be worked out offline.");
    }
    var rows = capture.rowSurvey.rows;
    capture.rowsTotal = rows.length;
    // Infinity does not survive JSON.stringify -- it serialises as null -- so
    // record a number only when a cap was actually set. Truncation stays
    // detectable either way by comparing notes.length against rowsTotal, which
    // is how a 40-visit cap was caught across a whole ward after the fact.
    capture.fetchLimit = isFinite(max) ? max : null;
    console.log("[OPD_diff] " + rows.length + " row(s); fetching " +
                (isFinite(max) ? "up to " + max : "all of them"));
    if (rows.length > max) {
      console.warn("[OPD_diff] Only the newest " + max + " of " + rows.length +
                   " visits will be fetched -- the OLDEST history is dropped, " +
                   "which is usually the diagnosis and the first treatment.");
    }

    // Also record whether the list page hints at paging -- unresolved question of
    // whether findOpd returns full history or a default window.
    capture.pagingHints = collectPagingHints(doc);

    var fetched = 0;
    for (var i = 0; i < rows.length && fetched < max; i++) {
      var noteUrl = noteUrlForRow(rows[i]);
      if (!noteUrl) {
        capture.errors.push({ rowIndex: i, error: "no usable link in row" });
        continue;
      }
      await politeDelay();
      try {
        var page = await getPage(noteUrl);
        page.rowIndex = i;
        page.rowCells = rows[i].cells;
        capture.notes.push(page);
        fetched++;
        var total = Math.min(max, rows.length);
        console.log("[OPD_diff] " + fetched + "/" + total +
                    "  row " + i + "  " + page.byteLength + " bytes  " + page.charset);
        // A console line is enough when this is pasted into DevTools, but the
        // extension overlay has nowhere to show it: at 400-1000ms per note a
        // 138-visit patient takes about two minutes, which reads as a hang.
        // Wrapped, because a broken UI callback must never abort a capture that
        // is already several dozen requests in.
        if (typeof options.onProgress === "function") {
          try {
            options.onProgress(fetched, total);
          } catch (e) {
            console.warn("[OPD_diff] onProgress threw; continuing:", e);
          }
        }
      } catch (e) {
        capture.errors.push({ rowIndex: i, url: noteUrl, error: String(e) });
        console.warn("[OPD_diff] row " + i + " failed:", e);
      }
    }

    return capture;
  }

  /* True when a capture came back without a visit-list TABLE at all.
   *
   * The HIS answers an application error with HTTP 200 and an Error.jsp body, so
   * fetch() raises nothing and a run would otherwise finish "successfully" with
   * an empty capture -- which is how one ward produced twelve empty files that
   * nothing complained about until a harness run much later.
   *
   * Only when the table is ABSENT. A patient with a table and no rows simply has
   * no OPD visits, which is legitimate. */
  function captureFailed(capture) {
    return !capture || !capture.rowSurvey || !capture.rowSurvey.found;
  }

  async function run(histno, options) {
    var capture = await collect(histno, options);

    // The chart number deliberately does NOT go in the filename -- a filename is
    // not covered by content de-identification and leaks in directory listings,
    // download histories and screenshots. It is inside the JSON, where deid.py
    // replaces it.
    var name = "opd-capture-" + capture.capturedAt.replace(/[:.]/g, "-") + ".json";
    download(capture, name);
    console.log("[OPD_diff] done: " + capture.notes.length + " note(s), " +
                capture.errors.length + " error(s). Downloaded " + name);
    console.log("[OPD_diff] Move it to the shared folder, then immediately run:\n" +
                "  python tools/deid.py apply fixtures/" + name);

    // Downloaded first, then thrown: the raw page is what makes the cause
    // diagnosable offline.
    if (captureFailed(capture)) {
      throw new Error("no visit-list table for this patient -- list page returned " +
                      capture.list.byteLength + " bytes, HTTP " + capture.list.status +
                      " from " + capture.list.url.replace(/histno=[^&]*/, "histno=...") +
                      ". Raw page saved in " + name + " for diagnosis.");
    }
    return capture;
  }

  function collectPagingHints(doc) {
    var hints = [];
    var all = doc.querySelectorAll("a, select, input[type=submit], option");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var text = (el.textContent || el.value || "").trim();
      if (/next|prev|下一|上一|頁|more|全部|月/i.test(text) ||
          /tmonth|resdtmonth|page/i.test(el.getAttribute("name") || "") ||
          /tmonth|resdtmonth|page/i.test(el.getAttribute("href") || "")) {
        hints.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 60),
          name: el.getAttribute("name"),
          href: el.getAttribute("href")
        });
      }
    }
    return hints.slice(0, 40);
  }

  /* Chart numbers off a ward roster page (action=findPatient).
   *
   * Each 查 link carries the histno as its own element id:
   *   <a href="...action=findEmr&histno=<chart>&ward=<ward>-<bed>" id="<chart>"
   *      class="clickmenu01">查</a>
   * so a roster yields its whole ward without anyone clicking through it.
   *
   * The placeholders above are deliberate: a literal digit run after "histno="
   * is exactly what deid.py's chart rule matches, and an example chart number
   * written here would make this very file trip the guard and become unreadable
   * to every tool that names it. */
  function wardHistnos(root) {
    var links = (root || document).querySelectorAll("a.clickmenu01[id], a.clickmenu[id]");
    var seen = {}, out = [];
    for (var i = 0; i < links.length; i++) {
      var id = normalizeHistno(links[i].id);
      if (id && !seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    }
    return out;
  }

  var stopRequested = false;

  function stop() {
    stopRequested = true;
    console.warn("[OPD_diff] stop requested -- finishing the current patient, then halting.");
  }

  /* Capture several patients in one sitting.
   *
   * The gap BETWEEN patients is deliberately far longer than politeDelay(), which
   * paces notes within one chart. A clinician reading a ward produces bursts with
   * long, irregular pauses; a script grinding through at a steady half-second
   * looks like nothing a human does, and abnormal-activity blocks trigger on that
   * pattern rather than on volume. Hence a long jittered gap. There is no
   * per-patient cap: see run(), where any limit drops the oldest history.
   *
   * Each patient is independent: a failure is recorded and the batch continues.
   * The remaining list is logged after every patient, so a run cut short -- the VM
   * drops at ~12 h -- resumes instead of starting over.
   */
  async function runBatch(histnos, options) {
    options = options || {};
    var list = [], seen = {};
    // Normalised, not pattern-matched: a hyphenated chart number used to be
    // dropped from the batch silently, so a ward could come back short with
    // nothing saying so.
    (histnos || []).forEach(function (h) {
      var s = normalizeHistno(h);
      if (s && !seen[s]) { seen[s] = true; list.push(s); }
    });
    if (!list.length) {
      throw new Error("runBatch(histnos): pass an array of chart numbers, " +
                      "e.g. OPDCapture.runBatch(OPDCapture.wardHistnos())");
    }

    // Every visit by default, matching run(). The 40-visit cap used for the
    // first ward left 58% of visits uncaptured, and what it dropped was the
    // oldest history -- the part a course summary needs most. Expect roughly
    // one request per visit: 2472 visits across 50 patients is about 50 minutes
    // at this pacing. The rate is unchanged; only the total rises.
    var max = options.max == null ? Infinity : options.max;
    var gapMs = options.gapMs == null ? 20000 : options.gapMs;
    var jitterMs = options.gapJitterMs == null ? 15000 : options.gapJitterMs;
    stopRequested = false;

    console.log("[OPD_diff] batch: " + list.length + " patient(s), " +
                (isFinite(max) ? "up to " + max + " visit(s) each" : "every visit") +
                ", " + Math.round(gapMs / 1000) + "-" +
                Math.round((gapMs + jitterMs) / 1000) + "s between patients.");
    console.log("[OPD_diff] The browser will ask once to allow multiple downloads; " +
                "until you allow it the batch looks stalled. OPDCapture.stop() halts.");

    var done = [], failed = [], consecutiveFailures = 0;
    var ABORT_AFTER = 3;
    for (var i = 0; i < list.length; i++) {
      if (stopRequested) break;
      if (i) await sleep(gapMs + Math.random() * jitterMs);
      try {
        var capture = await run(list[i], { max: max });
        done.push({ notes: capture.notes.length, errors: capture.errors.length });
        consecutiveFailures = 0;
      } catch (e) {
        failed.push({ index: i, error: String(e) });
        consecutiveFailures++;
        console.warn("[OPD_diff] patient " + (i + 1) + " of " + list.length + " failed:", e);
        // Several in a row is a systemic fault -- the wrong host, an expired
        // session -- never several unlucky patients. Stop instead of walking a
        // whole ward writing empty files and burning an hour of requests.
        if (consecutiveFailures >= ABORT_AFTER) {
          console.error("[OPD_diff] " + ABORT_AFTER + " patients in a row failed; stopping. " +
                        "This is usually the wrong host or an expired session rather than " +
                        "a per-patient problem. Every capture that has worked came from " +
                        "rkeprd.vghtpe.gov.tw -- check the host in the address bar, and " +
                        "open the saved list page from the last download to see what the " +
                        "server actually returned.");
          break;
        }
      }
      var remaining = list.slice(i + 1);
      console.log("[OPD_diff] " + (i + 1) + "/" + list.length + " patient(s) attempted." +
                  (remaining.length
                    ? "  Resume with: OPDCapture.runBatch(" + JSON.stringify(remaining) +
                      ", { max: " + max + " })"
                    : ""));
    }
    if (stopRequested) {
      console.warn("[OPD_diff] halted after " + (done.length + failed.length) + " patient(s).");
    }
    console.log("[OPD_diff] batch finished: " + done.length + " captured, " +
                failed.length + " failed. De-identify the whole folder at once:\n" +
                "  python tools/deid.py apply <folder>");
    return { done: done, failed: failed };
  }

  window.OPDCapture = { run: run, collect: collect, captureFailed: captureFailed,
                        runBatch: runBatch, stop: stop, normalizeHistno: normalizeHistno,
                        wardHistnos: wardHistnos, getPage: getPage, version: 5 };
  console.log("[OPD_diff] capture.js ready.\n" +
              "  one patient : OPDCapture.run(\"<chart number>\")\n" +
              "  a ward      : OPDCapture.runBatch(OPDCapture.wardHistnos())\n" +
              "  halt        : OPDCapture.stop()");
})();
