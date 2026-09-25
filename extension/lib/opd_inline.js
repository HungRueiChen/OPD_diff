/* OPD_diff -- blame drawn directly onto the note the HIS is showing.
 *
 * The HIS loads a visit's note into its own page (the #opddetail box under the
 * visit list): a <fieldset> whose legend reads "[<date>_SOAP]", one header row
 * per section, and each section's text in a <pre>. This module colours that text
 * in place by the visit that first wrote each line, and shows the date on hover.
 *
 * Until now the extension never touched the record it sits on -- everything was
 * drawn in its own shadow-rooted panel. Drawing on the HIS's page is a different
 * kind of act, so it is held to rules the panel never needed:
 *
 *   1. NOT ONE CHARACTER CHANGES. Lines are wrapped in <span>s; no text node is
 *      edited, reordered or removed. undecorate() unwraps them, and the offline
 *      harness checks across the whole corpus that the page's text is identical
 *      while decorated and its markup identical once undecorated.
 *
 *   2. THE NOTE IS IDENTIFIED BY ITS CONTENT, not by date, clinic and doctor.
 *      A doctor sees many patients in one session, so those three are routinely
 *      shared across patients -- matching on them could colour one patient's
 *      note with another patient's history. The note on screen is parsed and
 *      its S, O and P text must equal a note in the record that was read. No
 *      match, no colour, and a line saying why.
 *
 *   3. IT SAYS WHEN IT DOES NOT KNOW. While the read is still arriving, lines
 *      credited to the oldest visit read so far are drawn grey and dashed and
 *      claim no date -- the same rule, for the same reason, as the Blame tab.
 *
 * Only lines are attributed, never words: the HIS rewrites dates and lab values
 * inside a line at every visit, and word-level colour on this page would be
 * unreadable. A line the blame cannot match (injected boilerplate such as the
 * TOCC block, which is stripped before diffing) is left uncoloured rather than
 * guessed at.
 *
 * Styles are inline on each span. No stylesheet is added to the HIS page, so
 * nothing here can restyle anything the HIS drew.
 *
 * Depends on OPDParse, OPDLineage and OPDView (for the colour ramp, so inline
 * colours are identical to the Blame tab's by construction).
 * Target: Chrome/Edge 109 (the last Windows 7 releases).
 */
(function (root) {
  "use strict";

  const SOAP_LEGEND = /\[(\d{4}-\d{2}-\d{2})_SOAP\]/;
  // Same header grammar as opd_parse.js, so both agree on where sections start.
  const SECTION_HEADER = /^([SOAP])\s*[:：]\s*(?:主觀資料|客觀資料|診斷|治療計畫)?$/;
  const SECTIONS = ["S", "O", "P"];

  const MARK = "data-opd-blame";
  const LEGEND_MARK = "data-opd-blame-legend";
  const STAMP = "data-opd-blame-stamp";

  // How far ahead a line may be looked for among the blame's lines. Boilerplate
  // stripped before diffing leaves small gaps; anything further is a mismatch
  // and stays uncoloured.
  const LOOKAHEAD = 12;
  const UNTRACED = "#8a949e";

  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/\r/g, "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function legendElement(fieldset) {
    for (const child of fieldset.children) {
      if (child.tagName === "LEGEND") return child;
    }
    return null;
  }

  function legendText(fieldset) {
    const legend = legendElement(fieldset);
    return legend ? legend.textContent : "";
  }

  /* Every SOAP note fieldset in scope. The HIS also uses fieldsets for the visit
   * list and for its "[門診記錄內容]" placeholder; only the note's legend carries
   * the _SOAP date. */
  function findNoteFieldsets(scope) {
    return Array.from((scope || document).querySelectorAll("fieldset"))
      .filter((fs) => SOAP_LEGEND.test(legendText(fs)));
  }

  /* The content rows of each section, walked exactly as opd_parse.js walks them
   * so the two agree on which text belongs to which section. */
  function sectionRows(fieldset) {
    const rows = { S: [], O: [], P: [] };
    const taken = [];
    let current = null;
    for (const tr of fieldset.querySelectorAll("tr")) {
      // A nested table's rows are already inside a row being decorated.
      if (taken.some((t) => t.contains(tr))) continue;
      const text = OPDParse.textOf(tr);
      if (!text) continue;
      const header = SECTION_HEADER.exec(text);
      if (header) { current = header[1]; continue; }
      if (current && rows[current]) { rows[current].push(tr); taken.push(tr); }
    }
    return rows;
  }

  /* The visible lines of a section, each as the text-node ranges that compose
   * it. A line ends at a newline, at a <br>, and at a row boundary -- the same
   * three places opd_parse.js ends one. */
  function linesOf(rows) {
    const lines = [];
    let pieces = [];
    const flush = () => { lines.push(pieces); pieces = []; };
    rows.forEach((tr, r) => {
      if (r) flush();
      const walker = tr.ownerDocument.createTreeWalker(
        tr, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === 1) {
          if (n.tagName === "BR") flush();
          continue;
        }
        const parts = n.data.split("\n");
        let at = 0;
        parts.forEach((part, i) => {
          if (i) flush();
          if (part.length) pieces.push({ node: n, start: at, end: at + part.length });
          at += part.length + 1;
        });
      }
    });
    flush();
    return lines.map((p) => {
      const raw = p.map((x) => x.node.data.slice(x.start, x.end)).join("");
      return { pieces: p, raw, text: norm(raw), who: null, cut: 0 };
    });
  }

  /* Attribute each visible line to a blame line, in order. Greedy with a small
   * lookahead: a line the blame does not contain is skipped, never forced onto
   * the nearest guess. */
  function attribute(lines, segments, info) {
    const live = segments.filter((s) => !s.removedAt && norm(s.token));
    let j = 0;
    lines.forEach((line) => {
      if (!line.text) return;
      /* Clinical text can share a line with the end of an HIS boilerplate block
       * -- "【TOCC END】Insomnia. Mild dysphagia." -- and the block is stripped
       * before diffing, so the blame holds only what follows the "】". Match that
       * tail too, and colour only it: the marker itself stays plain. */
      const bracket = line.raw.lastIndexOf("】");
      const tail = bracket >= 0 ? norm(line.raw.slice(bracket + 1)) : "";
      for (let k = j; k < live.length && k <= j + LOOKAHEAD; k++) {
        const token = norm(live[k].token);
        if (token === line.text) line.cut = 0;
        else if (tail && token === tail) line.cut = bracket + 1;
        else continue;
        const seg = live[k];
        line.who = {
          date: seg.addedAt,
          index: seg.addedIndex,
          clinic: info.clinicOf.get(seg.addedIndex) || null,
          t: info.position.has(seg.addedIndex) ? info.position.get(seg.addedIndex) : 1,
          untraced: info.streaming && seg.addedIndex === info.rootIndex,
        };
        j = k + 1;
        break;
      }
    });
  }

  function styleSpan(span, who) {
    const jet = OPDView.jetCss;
    span.style.display = "inline";
    if (who.untraced) {
      span.style.borderBottom = "2px dashed " + UNTRACED;
      span.title = "not yet traced — older visits are still being read";
    } else {
      // Colour on the wash and the underline, never the glyphs: the HIS already
      // colours this text, and jet's midrange is unreadable as text anyway.
      span.style.background = jet(who.t, 0.22);
      span.style.borderBottom = "2px solid " + jet(who.t);
      span.title = "written " + who.date + (who.clinic ? " · " + who.clinic : "");
    }
  }

  /* Wrap each attributed line's text in spans. Leading and trailing whitespace
   * is left outside the span so indentation does not get a coloured wash.
   * Ranges are applied back to front within each text node so the offsets of
   * the ones still to come stay valid. */
  function wrap(lines, doc) {
    const byNode = new Map();
    lines.forEach((line) => {
      if (!line.who) return;
      let offset = 0;
      line.pieces.forEach((p) => {
        // Skip the part of the line before `cut` (a boilerplate marker).
        const len = p.end - p.start;
        const skip = Math.max(0, line.cut - offset);
        offset += len;
        if (skip >= len) return;
        const s = p.node.data.slice(p.start + skip, p.end);
        const lead = s.length - s.replace(/^[\s ]+/, "").length;
        const trail = s.length - s.replace(/[\s ]+$/, "").length;
        const a = p.start + skip + lead;
        const b = p.end - trail;
        if (b <= a) return;
        if (!byNode.has(p.node)) byNode.set(p.node, []);
        byNode.get(p.node).push({ a, b, who: line.who });
      });
    });
    let wrapped = 0;
    byNode.forEach((ranges, node) => {
      ranges.sort((x, y) => y.a - x.a);
      ranges.forEach((r) => {
        const mid = node.splitText(r.a);
        mid.splitText(r.b - r.a);
        const span = doc.createElement("span");
        span.setAttribute(MARK, "");
        styleSpan(span, r.who);
        mid.parentNode.insertBefore(span, mid);
        span.appendChild(mid);
        wrapped++;
      });
    });
    return wrapped;
  }

  /* The pdf-export button's parameters: date, clinic code, doctor code. Used
   * ONLY to break a tie between notes whose text is identical -- never to
   * identify the note, for the reason given at the top of this file. */
  function pdfKey(fieldset) {
    const el = fieldset.querySelector("[onclick*='pdf.cfm'], a[href*='pdf.cfm']");
    const raw = el ? (el.getAttribute("onclick") || el.getAttribute("href") || "") : "";
    const m = /pdf\.cfm\?([^'")\s]*)/.exec(raw);
    if (!m) return null;
    const q = new URLSearchParams(m[1]);
    return [q.get("dt") || "", q.get("dept") || "", q.get("doc") || ""].join("|");
  }

  function box(doc, children, tone) {
    const div = doc.createElement("div");
    div.setAttribute(LEGEND_MARK, "");
    div.style.cssText = [
      "margin:4px 0 6px", "padding:4px 8px", "border-radius:4px",
      "font:12px/1.5 system-ui,'Segoe UI','Noto Sans TC',sans-serif",
      "white-space:normal", "text-align:left",
      tone === "warn"
        ? "color:#7a4b00;background:#fef5e7;border:1px solid #f0d9a8"
        : "color:#41505e;background:#f4f7f9;border:1px solid #d7dde3",
    ].join(";");
    children.forEach((c) => div.appendChild(typeof c === "string" ? doc.createTextNode(c) : c));
    return div;
  }

  function scale(doc, chain) {
    const jet = OPDView.jetCss;
    const wrapEl = doc.createElement("span");
    wrapEl.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:6px;vertical-align:middle";
    const from = doc.createElement("span");
    from.textContent = chain[0].date;
    const bar = doc.createElement("span");
    bar.style.cssText = "display:inline-block;width:120px;height:8px;border-radius:4px;background:linear-gradient(to right," +
      [0, 0.25, 0.5, 0.75, 1].map((t) => jet(t)).join(",") + ")";
    const to = doc.createElement("span");
    to.textContent = chain[chain.length - 1].date;
    wrapEl.appendChild(from);
    wrapEl.appendChild(bar);
    wrapEl.appendChild(to);
    return wrapEl;
  }

  function placeLegend(fieldset, el) {
    const legend = legendElement(fieldset);
    if (legend) legend.insertAdjacentElement("afterend", el);
    else fieldset.insertBefore(el, fieldset.firstChild);
  }

  /* Colour one note in place. Always undecorates first, so calling it again
   * with a newer model -- the next rebuild of a read still arriving -- simply
   * redraws. Returns what it did, for the caller and for the harness. */
  function decorate(fieldset, model, options) {
    const opts = options || {};
    const doc = fieldset.ownerDocument;
    undecorate(fieldset);
    fieldset.setAttribute(STAMP, String(opts.stamp == null ? "" : opts.stamp));

    const result = { status: null, nodeIndex: null, date: null, lines: 0, attributed: 0,
                     own: 0, untraced: 0, spans: 0, chainLength: 0, candidates: 0 };
    if (!model || !model.lineage) { result.status = "no-model"; return result; }

    const streaming = model.done === false;
    const parsed = OPDParse.parseNote(fieldset.outerHTML);
    result.date = parsed.soapDate;
    const want = SECTIONS.map((k) => parsed.sections[k].text);
    const nodes = model.lineage.nodes;
    const same = (n) => SECTIONS.every((k, i) => n.note.sections[k].text === want[i]);

    let candidates = [];
    if (want.some(Boolean)) {
      candidates = nodes.filter((n) => n.visit.date === parsed.soapDate && same(n));
      if (!candidates.length) candidates = nodes.filter(same);
    }
    result.candidates = candidates.length;
    if (candidates.length > 1) {
      const key = pdfKey(fieldset);
      const exact = key ? candidates.filter((n) => n.visit.key === key) : [];
      if (exact.length) candidates = exact;
    }

    const node = candidates[0];
    if (!node) {
      const listed = (model.visits || []).some((v) => v.date === parsed.soapDate);
      if (streaming && listed) {
        result.status = "not-read";
        placeLegend(fieldset, box(doc, [
          "OPD_diff: this visit has not been read yet (" + model.loaded + " of " +
          (model.total || "?") + "). It will be coloured when it arrives.",
        ], "warn"));
      } else {
        result.status = "mismatch";
        placeLegend(fieldset, box(doc, [
          "OPD_diff: this note does not match any note in the record that was read, " +
          "so it has not been coloured. If it was edited since, press OPD_diff to read again.",
        ], "warn"));
      }
      return result;
    }

    result.nodeIndex = node.index;
    const rows = sectionRows(fieldset);
    let chain = [];
    const all = [];
    SECTIONS.forEach((key) => {
      const lines = linesOf(rows[key]);
      const blame = OPDLineage.blame(nodes, node.index, key, { granularity: "line" });
      chain = blame.chain;
      const position = new Map();
      chain.forEach((c, i) => position.set(c.index, chain.length === 1 ? 1 : i / (chain.length - 1)));
      attribute(lines, blame.segments, {
        clinicOf: new Map(chain.map((c) => [c.index, c.clinic])),
        position,
        rootIndex: chain.length ? chain[0].index : null,
        streaming,
      });
      lines.forEach((l) => all.push(l));
    });

    if (opts.debug) result.plainLines = [];
    all.forEach((l) => {
      if (!l.text) return;
      result.lines++;
      if (!l.who) { if (opts.debug) result.plainLines.push(l.text); return; }
      result.attributed++;
      if (l.who.untraced) result.untraced++;
      else if (l.who.index === node.index) result.own++;
    });
    result.chainLength = chain.length;
    result.spans = wrap(all, doc);
    result.status = "decorated";

    const traced = result.attributed - result.untraced;
    const parts = [
      "OPD_diff blame · colour = the visit that first wrote each line, blue oldest → red newest · hover a line for its date · ",
      result.own + " of " + result.attributed + " coloured lines first written at this visit",
    ];
    // Said outright, so an uncoloured line is not read as "written today". It is
    // "almost always", not "always": measured across the corpus, 29271 of 29301
    // plain lines are boilerplate, and the other 30 are real text the line
    // matcher could not place.
    parts.push(" · uncoloured lines are almost always HIS boilerplate (TOCC questionnaire, pain scores) that OPD_diff does not track");
    if (chain.length > 1 && traced) parts.push(scale(doc, chain));
    if (streaming) {
      parts.push(". Still reading older visits (" + model.loaded + " of " + (model.total || "?") +
                 "): grey dashed lines are not traced yet and may be older than they look.");
    }
    placeLegend(fieldset, box(doc, parts, streaming ? "warn" : null));
    return result;
  }

  /* Remove every trace of decoration under `scope`: unwrap spans, drop legends
   * and stamps, and merge the text nodes that wrapping split. */
  function undecorate(scope) {
    const rootEl = scope || document;
    rootEl.querySelectorAll("[" + LEGEND_MARK + "]").forEach((el) => el.remove());
    const parents = new Set();
    rootEl.querySelectorAll("span[" + MARK + "]").forEach((span) => {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parents.add(parent);
    });
    parents.forEach((p) => p.normalize());
    if (rootEl.nodeType === 1 && rootEl.hasAttribute(STAMP)) rootEl.removeAttribute(STAMP);
    rootEl.querySelectorAll("[" + STAMP + "]").forEach((el) => el.removeAttribute(STAMP));
  }

  function stampOf(fieldset) { return fieldset.getAttribute(STAMP); }

  const api = { decorate, undecorate, findNoteFieldsets, stampOf, version: 1 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDInline = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
