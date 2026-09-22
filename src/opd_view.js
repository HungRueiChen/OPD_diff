/* OPD_diff -- the reading surface: course timeline, side-by-side compare, blame.
 *
 * Three modes over the same data:
 *   Course  -- the patient-level timeline: what was newly written, when, where.
 *   Compare -- the visits YOU pick, side by side. Each column highlights what it
 *              gained from the column on its left and strikes through what the
 *              column on its right drops, so a pair reads as one diff.
 *   Blame   -- one visit, with every run of text that has ever appeared in its
 *              ancestry, coloured by the visit that introduced it.
 *
 * Which visits are shown is a choice, not a guess: the picker lists every visit
 * newest first (as the HIS does), filterable, and any number can be ticked.
 *
 * Compare defaults to showing only changed lines with a little context.
 * Copy-forward means two consecutive notes are typically 95% identical, so a
 * full-text view buries the day's actual change under sixty unchanged lines.
 *
 * Every string from a note is written with textContent, never innerHTML. Note
 * text is clinician free text that can contain anything, and this page is also
 * rendered inside the HIS tab by the overlay.
 *
 * Target: Chrome/Edge 109 (the last Windows 7 releases). No CSS nesting, no
 * top-level await, no syntax past ES2022.
 */
(function (root) {
  "use strict";

  // Compare columns: sequential hues, earlier cooler and later warmer, so a scan
  // across columns reads as time. Colour never carries meaning alone -- additions
  // are underlined and removals struck. Compare is a plain text comparison: no
  // tooltips, and every number on it is measured against the column to its left.
  const HUES = [205, 190, 160, 120, 45, 25, 0, 320, 280, 245];
  const MAX_COLUMNS = 6;
  // Token-level diffs cut inside dates and version numbers (a YYYY/MM/DD date
  // becomes five tokens), so runs this close together are joined into one mark.
  const MERGE_GAP = 3;
  const CONTEXT_LINES = 1;
  const MIN_GAP = 2;
  const HAS_CONTENT = /[\p{L}\p{N}]/u;

  const CSS = [
    ".opd{font:14px/1.55 system-ui,'Segoe UI','Noto Sans TC',sans-serif;color:#1b1f24;background:#fff;height:100%;display:flex;flex-direction:column}",
    ".opd *{box-sizing:border-box}",
    ".opd-head{display:flex;gap:16px;align-items:baseline;padding:10px 16px;border-bottom:1px solid #d7dde3;flex-wrap:wrap}",
    ".opd-title{font-weight:600}",
    ".opd-sub{color:#5b6672;font-size:13px}",
    ".opd-tabs{margin-left:auto;display:flex;gap:4px}",
    ".opd-tab{border:1px solid #c7d0d9;background:#f4f7f9;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit}",
    ".opd-tab[aria-pressed=true]{background:#1b4f72;border-color:#1b4f72;color:#fff}",
    ".opd-body{display:flex;min-height:0;flex:1}",
    ".opd-picker{width:290px;flex:none;border-right:1px solid #d7dde3;display:flex;flex-direction:column;min-height:0}",
    ".opd-picker-head{padding:8px 10px;border-bottom:1px solid #e6eaee;display:flex;flex-direction:column;gap:6px}",
    ".opd-picker-head select,.opd-picker-head input{font:inherit;padding:3px 6px;border:1px solid #c7d0d9;border-radius:5px;width:100%}",
    ".opd-picker-actions{display:flex;gap:6px}",
    ".opd-picker-actions button{flex:1;font:inherit;font-size:12px;padding:3px 6px;border:1px solid #c7d0d9;background:#fff;border-radius:5px;cursor:pointer}",
    ".opd-list{overflow:auto;flex:1;min-height:0}",
    ".opd-visit{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid #f0f3f5;cursor:pointer;align-items:flex-start}",
    ".opd-visit:hover{background:#f6f9fb}",
    ".opd-visit.sel{background:#eaf2f8}",
    ".opd-visit input{margin-top:3px}",
    ".opd-visit-main{min-width:0;flex:1}",
    ".opd-visit-date{font-variant-numeric:tabular-nums;font-weight:600}",
    ".opd-visit-meta{color:#5b6672;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".opd-chip{display:inline-block;font-size:11px;padding:0 5px;border-radius:9px;background:#eef2f5;color:#41505e;margin-right:3px}",
    ".opd-chip.dx{background:#e8f0fb;color:#1b4f72}",
    ".opd-chip.base{background:#f3e8fb;color:#5b2d82}",
    ".opd-main{flex:1;overflow:auto;padding:14px 16px;min-width:0}",
    ".opd-hint{color:#5b6672;padding:24px;text-align:center}",
    ".opd-eventrow{display:grid;grid-template-columns:96px 120px 150px 1fr;gap:10px;padding:5px 0;border-bottom:1px solid #f0f3f5;align-items:baseline}",
    ".opd-eventrow:hover{background:#f8fafc}",
    ".opd-date{font-variant-numeric:tabular-nums;color:#41505e}",
    ".opd-kinds{display:flex;gap:3px;flex-wrap:wrap}",
    ".opd-kind{font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:9px;background:#eef2f5;color:#41505e}",
    ".opd-kind.status{background:#fdecea;color:#922b21}",
    ".opd-kind.stage{background:#fef5e7;color:#9c640c}",
    ".opd-kind.treatment{background:#eafaf1;color:#196f3d}",
    ".opd-kind.imaging{background:#eaf2f8;color:#1b4f72}",
    ".opd-kind.marker{background:#f4ecf7;color:#6c3483}",
    ".opd-kind.finding{background:#e8f8f0;color:#186a3b}",
    ".opd-kind.toxicity{background:#fdedec;color:#943126}",
    ".opd-text{white-space:pre-wrap;word-break:break-word}",
    // One grid filled row by row, so every column's S/O/A/P -- and the weight and
    // pain rows under them -- sit on the same line however tall a neighbour runs.
    // No subgrid: that is Chrome 117+, past the 109 floor this has to clear.
    ".opd-cols{display:grid;gap:0;align-items:stretch}",
    ".opd-cell{min-width:0;padding:6px 10px 8px;border-left:1px solid #e6eaee}",
    ".opd-cell.first{border-left:0}",
    ".opd-cell.head{padding:8px 10px;border-bottom:1px solid #e6eaee;background:#f8fafc}",
    ".opd-cell.rowtop{border-top:1px solid #f0f3f5}",
    ".opd-cell h4{margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5b6672}",
    ".opd-cell pre,.opd-blame pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}",
    ".opd-mark{border-bottom:2px solid currentColor;padding:0 1px;border-radius:2px}",
    ".opd-del{text-decoration:line-through;text-decoration-thickness:2px;opacity:.8}",
    ".opd-gap{color:#8a949e;font-size:12px;font-style:italic;padding:2px 0}",
    ".opd-nochange{color:#8a949e;font-size:13px;padding:2px 0}",
    ".opd-lane{font-size:12px;color:#41505e;margin-top:6px}",
    ".opd-lane b{font-weight:600;color:#1b1f24}",
    ".opd-legend{font-size:12px;color:#5b6672;margin-bottom:10px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}",
    ".opd-scale{display:flex;gap:0;align-items:stretch;margin:6px 0 12px;flex-wrap:wrap}",
    ".opd-stop{font-size:11px;padding:2px 8px;color:#1b1f24;border-top:4px solid currentColor;white-space:nowrap}",
    "@media (prefers-color-scheme:dark){",
    ".opd{color:#e6eaee;background:#14181c}",
    ".opd-head,.opd-picker,.opd-picker-head{border-color:#2b3238}",
    ".opd-visit{border-color:#20262b}.opd-visit:hover{background:#1b2126}.opd-visit.sel{background:#1d2b38}",
    ".opd-tab{background:#1b2126;border-color:#2b3238;color:#e6eaee}",
    ".opd-cell.head{background:#1b2126}.opd-cell{border-left-color:#2b3238}",
    ".opd-cell.rowtop{border-top-color:#20262b}.opd-eventrow{border-color:#20262b}",
    ".opd-chip,.opd-kind{background:#232a30;color:#c3ccd5}",
    ".opd-picker-actions button,.opd-picker-head select,.opd-picker-head input{background:#1b2126;color:#e6eaee;border-color:#2b3238}",
    ".opd-stop{color:#e6eaee}",
    "}",
  ].join("\n");

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "class") node.className = attrs[k];
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => { if (c) node.appendChild(c); });
    return node;
  }

  function hueFor(index) { return HUES[index % HUES.length]; }
  function colourFor(index) { return "hsl(" + hueFor(index) + " 65% 34%)"; }
  function washFor(index) { return "hsl(" + hueFor(index) + " 85% 92% / .85)"; }

  /* The classic jet ramp, blue through cyan, green and yellow to red, for the
   * blame scale where position means time. (Jet is not perceptually uniform; if
   * that matters later, only this function has to change.) */
  function jet(t) {
    const x = Math.min(1, Math.max(0, t));
    const clamp = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
    return {
      r: clamp(1.5 - Math.abs(4 * x - 3)),
      g: clamp(1.5 - Math.abs(4 * x - 2)),
      b: clamp(1.5 - Math.abs(4 * x - 1)),
    };
  }

  function jetCss(t, alpha) {
    const c = jet(t);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + (alpha == null ? 1 : alpha) + ")";
  }

  /* Join runs separated by a sliver of punctuation, and drop marks that would
   * highlight nothing but a slash or a bracket. */
  function mergeRanges(text, ranges) {
    const out = [];
    (ranges || []).slice().sort((a, b) => a.start - b.start).forEach((r) => {
      const last = out[out.length - 1];
      const between = last ? text.slice(last.end, r.start) : null;
      if (last && r.start - last.end <= MERGE_GAP && !HAS_CONTENT.test(between)) {
        last.end = Math.max(last.end, r.end);
      } else {
        out.push({ start: r.start, end: r.end, kind: r.kind });
      }
    });
    return out.filter((r) => HAS_CONTENT.test(text.slice(r.start, r.end)));
  }

  function lineSpans(text) {
    const spans = [];
    let start = 0;
    text.split("\n").forEach((line) => {
      spans.push({ start, end: start + line.length, text: line });
      start += line.length + 1;
    });
    return spans;
  }

  /* Render one line, marking the parts of it that changed. Marks carry a kind
   * ("add" or "del") and their own colour and tooltip. */
  function markedLine(span, marks, styleFor) {
    const frag = document.createDocumentFragment();
    let at = span.start;
    marks.forEach((m) => {
      const from = Math.max(m.start, span.start);
      const to = Math.min(m.end, span.end);
      if (to <= from || from < at) return;
      if (from > at) frag.appendChild(document.createTextNode(span.text.slice(at - span.start, from - span.start)));
      const style = styleFor(m);
      const node = el("span", {
        class: "opd-mark" + (m.kind === "del" ? " opd-del" : ""),
        title: style.title,
        text: span.text.slice(from - span.start, to - span.start),
      });
      node.style.color = style.colour;
      if (style.wash) node.style.background = style.wash;
      frag.appendChild(node);
      at = to;
    });
    if (at < span.end) frag.appendChild(document.createTextNode(span.text.slice(at - span.start)));
    return frag;
  }

  function visitLabel(visit) {
    const clinic = (visit.dept && visit.dept.clinic) || "";
    return visit.date + (clinic ? " " + clinic : "");
  }

  function sectionTextOf(node, key) {
    return OPDLineage.sectionText(node.note, key);
  }

  function mount(rootEl, data, options) {
    const opts = Object.assign({ maxColumns: MAX_COLUMNS }, options);
    // Mutable, because update() swaps the whole model in as a capture streams.
    // Everything below reads through these three, never through the argument.
    let model = data;
    let nodes = model.lineage.nodes;
    let course = model.course;

    /* Default to the most recent visit that has a parent, plus that parent: the
     * comparison a clinician opens this for. Falling back to "the last two rows"
     * would often pair two different clinics on the same day. */
    function defaultSelection() {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].parent) return [nodes[nodes[i].parent.index].visit.key, nodes[i].visit.key];
      }
      return nodes.slice(-2).map((n) => n.visit.key);
    }

    const state = {
      // Compare, not course. Course is beta: the text it quotes is real, but the
      // category it assigns that text is often wrong, so it must not be the tab
      // this opens on.
      mode: "compare",
      selected: new Set(defaultSelection()),
      clinic: "",
      query: "",
      changesOnly: true,
      blameSection: "O",
      blameGranularity: "line",
      // Off by default: each visit replaces the whole CTCAE block, so a long
      // chain leaves one dead block per stop and the surviving note -- the thing
      // actually selected -- ends up buried under its own history.
      blameShowRemoved: false,
      /* Set the moment the reader ticks anything. Until then the default
       * selection is recomputed on every update, so a streaming load slides
       * forward to the newest comparable pair as soon as one exists. After it,
       * the reader's choice is never overridden -- a selection that jumped out
       * from under someone mid-read would be worse than a slow one. */
      userPicked: false,
    };

    rootEl.textContent = "";
    rootEl.appendChild(el("style", { text: CSS }));
    const container = el("div", { class: "opd" });
    rootEl.appendChild(container);

    const listEl = el("div", { class: "opd-list" });
    const mainEl = el("main", { class: "opd-main" });
    const countEl = el("span", { class: "opd-sub", text: "" });
    const subEl = el("span", { class: "opd-sub", text: "" });
    const tabButtons = {};

    function streaming() { return model.done === false; }

    function selectedNodes() {
      return nodes.filter((n) => state.selected.has(n.visit.key)).slice(0, opts.maxColumns);
    }

    /* Every visit the list advertised, newest first, INCLUDING those whose note
     * has not been read yet -- they appear as pending rows.
     *
     * The visit list arrives in a single request, so the picker is complete from
     * the first moment of a read that may take two minutes. Showing only what
     * has been parsed would make the record appear to grow from nothing, and a
     * clinician cannot tell that from a record that is simply short.
     *
     * Falls back to the loaded nodes when no list was supplied, which is how the
     * offline harness mounts an already-finished model. */
    function shownRows() {
      const q = state.query.trim().toLowerCase();
      const byKey = new Map(nodes.map((n) => [n.visit.key, n]));
      const rows = (model.visits && model.visits.length)
        ? model.visits.map((v) => ({ visit: v, node: byKey.get(v.key) || null }))
        : nodes.slice().reverse().map((n) => ({ visit: n.visit, node: n }));
      return rows.filter((row) => {
        const clinic = (row.visit.dept && row.visit.dept.clinic) || "";
        if (state.clinic && clinic !== state.clinic) return false;
        if (!q) return true;
        const hay = [row.visit.date, clinic, row.visit.doctor && row.visit.doctor.name,
                     (row.visit.icd10 || []).join(" ")].join(" ").toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }

    /* The header is rewritten on every update, so it carries the read's
     * progress: how much of the record is on screen, and whether more is
     * coming. "12 of 138 visits read" is the difference between a tool that is
     * working and a tool that has hung. */
    function refreshHead() {
      const from = course.patient.from;
      const to = course.patient.to;
      const span = (from && to) ? from + " – " + to : "no dates read yet";
      const total = model.total || course.patient.visits;
      const read = streaming() && total
        ? model.loaded + " of " + total + " visits read"
        : course.patient.visits + " visits";
      subEl.textContent = read + " · " + span + " · " + course.patient.clinics.length + " clinics";
      countEl.textContent = state.selected.size + " selected" + (streaming() ? " · still reading…" : "");
    }

    function buildHead() {
      // Course sits last and says "beta" on its face. Its classification is not
      // reliable enough to lead with, and a tab that looks like the others
      // borrows a credibility it has not earned.
      const tabs = el("div", { class: "opd-tabs" }, ["compare", "blame", "course"].map((mode) => {
        const button = el("button", {
          class: "opd-tab", "aria-pressed": String(state.mode === mode),
          text: mode === "course" ? "Course (beta)" : mode.charAt(0).toUpperCase() + mode.slice(1),
          onclick: () => {
            state.mode = mode;
            Object.keys(tabButtons).forEach((k) => tabButtons[k].setAttribute("aria-pressed", String(k === mode)));
            renderMain();
          },
        });
        tabButtons[mode] = button;
        return button;
      }));
      return el("header", { class: "opd-head" }, [
        el("span", { class: "opd-title", text: model.caseName || "OPD course" }),
        subEl,
        countEl,
        tabs,
      ]);
    }

    function buildPicker() {
      const clinicSel = el("select", { onchange: (e) => { state.clinic = e.target.value; renderList(); renderMain(); } },
        [el("option", { value: "", text: "All clinics" })].concat(
          course.patient.clinics.map((c) => el("option", { value: c, text: c, selected: state.clinic === c ? "selected" : null }))));
      const search = el("input", {
        type: "search", placeholder: "Filter by date, doctor, code", value: state.query,
        oninput: (e) => { state.query = e.target.value; renderList(); },
      });
      const actions = el("div", { class: "opd-picker-actions" }, [
        // Only rows whose note is actually parsed can be selected: a column for
        // a visit that has not been read would have nothing to show.
        el("button", { text: "Select shown", onclick: () => {
          state.userPicked = true;
          shownRows().forEach((row) => { if (row.node) state.selected.add(row.visit.key); });
          renderList(); renderMain();
        } }),
        el("button", { text: "Clear", onclick: () => {
          state.userPicked = true;
          state.selected.clear(); renderList(); renderMain();
        } }),
      ]);
      return el("aside", { class: "opd-picker" }, [
        el("div", { class: "opd-picker-head" }, [clinicSel, search, actions]),
        listEl,
      ]);
    }

    /* Rebuilt when a filter changes and on every update. Ticking a visit updates
     * that row in place, so the list never scrolls back to the top under the
     * reader -- and the saved scrollTop keeps that true while notes stream in
     * underneath. */
    function renderList() {
      const keepScroll = listEl.scrollTop;
      listEl.textContent = "";
      const shown = shownRows();
      if (!shown.length) {
        listEl.appendChild(el("div", {
          class: "opd-hint",
          text: (model.visits && model.visits.length) || nodes.length
            ? "No visit matches this filter."
            : "Reading the visit list…",
        }));
        return;
      }
      shown.forEach((row) => {
        const visit = row.visit;
        const node = row.node;
        const selected = state.selected.has(visit.key);
        const box = el("input", {
          type: "checkbox",
          checked: selected ? "checked" : null,
          disabled: node ? null : "disabled",
        });
        const line = el("div", {
          class: "opd-visit" + (selected ? " sel" : ""),
          onclick: (e) => {
            // A visit whose note has not arrived cannot be compared yet. It is
            // shown, so the reader knows it exists and is coming, but it is not
            // selectable until there is something behind it.
            if (!node) return;
            state.userPicked = true;
            if (e.target !== box) box.checked = !box.checked;
            if (box.checked) state.selected.add(visit.key);
            else state.selected.delete(visit.key);
            line.className = "opd-visit" + (box.checked ? " sel" : "");
            renderMain();
          },
        }, [
          box,
          el("div", { class: "opd-visit-main" }, [
            el("div", { class: "opd-visit-date", text: visit.date }),
            el("div", { class: "opd-visit-meta", text: [(visit.dept && visit.dept.clinic) || "",
              (visit.doctor && visit.doctor.name) || ""].filter(Boolean).join(" · ") }),
            el("div", {}, (visit.icd10 || []).slice(0, 4)
              .map((code) => el("span", { class: "opd-chip dx", text: code }))
              .concat(node && node.isBaseline ? [el("span", { class: "opd-chip base", text: "baseline" })] : [])
              .concat(node ? [] : [el("span", { class: "opd-chip", text: "reading…" })])),
          ]),
        ]);
        // Inline rather than a class: the pending state is transient and this
        // keeps the stylesheet describing the finished view only.
        if (!node) { line.style.opacity = ".55"; line.style.cursor = "default"; }
        listEl.appendChild(line);
      });
      listEl.scrollTop = keepScroll;
    }

    /* One sentence can raise several kinds -- an imaging line that also states a
     * response -- so group by the text and show every kind on one row. */
    function groupedEvents() {
      const groups = new Map();
      course.events.forEach((e) => {
        const key = e.date + "|" + (e.clinic || "") + "|" + e.text;
        let g = groups.get(key);
        if (!g) {
          g = { date: e.date, clinic: e.clinic, text: e.text, kinds: [], detail: null };
          groups.set(key, g);
        }
        if (g.kinds.indexOf(e.kind) < 0) g.kinds.push(e.kind);
        if (e.kind === "marker") {
          // Qualitative markers carry a state instead of a number; "HER2 null"
          // would be worse than useless.
          g.detail = e.match + (e.value == null ? (e.state ? " " + e.state : "") : " " + e.value);
        }
        else if (e.kind === "stage" && !g.detail) g.detail = e.restaged ? e.match + " (was " + e.previousStage + ")" : e.match;
      });
      return Array.from(groups.values());
    }

    function renderCourse() {
      const wrap = el("div", {});
      wrap.appendChild(el("div", { class: "opd-legend" }, [
        el("span", { text: "BETA. Each row is text the attending newly wrote at that visit — the text itself is never inferred. The category chips often are wrong: one sentence usually carries several categories at once, and separating them reliably needs a language model. Read the chips as a hint, not a classification." }),
      ]));

      if (course.diagnoses.length) {
        wrap.appendChild(el("h4", { text: "Diagnoses, first appearance" }));
        course.diagnoses.forEach((d) => {
          wrap.appendChild(el("div", { class: "opd-eventrow" }, [
            el("span", { class: "opd-date", text: d.firstSeen.date }),
            el("span", { class: "opd-sub", text: d.firstSeen.clinic || "" }),
            el("span", { class: "opd-kinds" }, [el("span", { class: "opd-kind", text: d.ruleOut ? "rule out" : "dx" })]),
            el("span", { class: "opd-text", text: (d.qualifier ? d.qualifier + " " : "") + d.code + " " + (d.text || "") + " · seen at " + d.visits + " visits" }),
          ]));
        });
      }

      // One column, chronological, with the kinds as chips on the row. Splitting
      // these into per-category columns was tried and reverted: a sentence
      // usually carries several categories at once, so the same paragraph
      // repeated across three columns read worse than one list, and it lent
      // misclassifications an air of authority they had not earned.
      wrap.appendChild(el("h4", { text: "Timeline" }));
      const groups = groupedEvents();
      if (!groups.length) wrap.appendChild(el("div", { class: "opd-hint", text: "No timeline events extracted." }));
      groups.forEach((g) => {
        wrap.appendChild(el("div", { class: "opd-eventrow" }, [
          el("span", { class: "opd-date", text: g.date }),
          el("span", { class: "opd-sub", text: g.clinic || "" }),
          el("span", { class: "opd-kinds" }, g.kinds.map((k) => el("span", { class: "opd-kind " + k, text: k }))),
          el("span", { class: "opd-text", text: (g.detail ? g.detail + " — " : "") + g.text }),
        ]));
      });
      return wrap;
    }

    function laneLine(label, items) {
      if (!items || !items.length) return null;
      return el("div", { class: "opd-lane" }, [el("b", { text: label + ": " }), el("span", { text: items.join("; ") })]);
    }

    /* Changed lines plus a line of context, with untouched stretches collapsed. */
    function renderSectionBody(text, marks, styleFor) {
      const spans = lineSpans(text);
      const pre = el("pre", {});
      if (!marks.length) {
        if (state.changesOnly) return el("div", { class: "opd-nochange", text: "no change in this section" });
        spans.forEach((span, i) => {
          if (i) pre.appendChild(document.createTextNode("\n"));
          pre.appendChild(markedLine(span, marks, styleFor));
        });
        return pre;
      }
      if (!state.changesOnly) {
        spans.forEach((span, i) => {
          if (i) pre.appendChild(document.createTextNode("\n"));
          pre.appendChild(markedLine(span, marks, styleFor));
        });
        return pre;
      }

      const keep = new Set();
      spans.forEach((span, i) => {
        if (!marks.some((r) => r.start < span.end + 1 && r.end > span.start)) return;
        for (let k = i - CONTEXT_LINES; k <= i + CONTEXT_LINES; k++) {
          if (k >= 0 && k < spans.length) keep.add(k);
        }
      });

      let hidden = 0;
      let wrote = false;
      spans.forEach((span, i) => {
        if (!keep.has(i)) { hidden++; return; }
        if (hidden >= MIN_GAP) {
          pre.appendChild(el("div", { class: "opd-gap", text: "… " + hidden + " unchanged lines …" }));
          wrote = false;
        } else if (hidden > 0) {
          for (let k = i - hidden; k < i; k++) {
            pre.appendChild(document.createTextNode((wrote ? "\n" : "") + spans[k].text));
            wrote = true;
          }
        }
        hidden = 0;
        if (wrote) pre.appendChild(document.createTextNode("\n"));
        pre.appendChild(markedLine(span, marks, styleFor));
        wrote = true;
      });
      if (hidden >= MIN_GAP) pre.appendChild(el("div", { class: "opd-gap", text: "… " + hidden + " unchanged lines …" }));
      return pre;
    }

    function renderCompare() {
      const picked = selectedNodes();
      if (picked.length < 2) {
        // Early in a read there is nothing to pick yet, so the standing
        // instruction would be telling the reader to do something impossible.
        // Say what is actually happening instead.
        const waiting = streaming() && nodes.length < 2;
        return el("div", { class: "opd-hint", text: waiting
          ? "Reading visits… the two most recent will appear here side by side as soon as they arrive."
          : "Pick two or more visits on the left to compare them side by side." });
      }
      const wrap = el("div", {});
      wrap.appendChild(el("div", { class: "opd-legend" }, [
        el("button", {
          class: "opd-tab",
          text: state.changesOnly ? "Showing: changes only" : "Showing: full note",
          onclick: () => { state.changesOnly = !state.changesOnly; renderMain(); },
        }),
        el("span", { text: "Underlined = added in that column. Struck through = dropped by the next column. Every column — text and numbers alike — is measured against the column to its left." }),
      ]));

      const n = picked.length;
      const cols = el("div", { class: "opd-cols" });
      cols.style.gridTemplateColumns = "repeat(" + n + ", minmax(240px, 1fr))";
      const cell = (idx, cls, children) =>
        el("div", { class: "opd-cell" + (idx ? "" : " first") + (cls ? " " + cls : "") }, children);

      /* Measured against the previous SELECTED column, not against each note's
       * copy-forward parent. The parent is chosen by similarity and is often not
       * on screen at all, so a weight quoted against it looks like it refers to
       * the column alongside when it does not. */
      const deltas = picked.map((node, idx) => OPDLineage.diffNotes(
        idx ? picked[idx - 1].note : null, node.note,
        idx ? picked[idx - 1].visit.date : null, node.visit.date));

      picked.forEach((node, idx) => {
        const prev = idx > 0 ? picked[idx - 1] : null;
        const next = idx < n - 1 ? picked[idx + 1] : null;
        const head = cell(idx, "head", [
          el("div", { class: "opd-visit-date", text: node.visit.date }),
          el("div", { class: "opd-visit-meta", text: [(node.visit.dept && node.visit.dept.clinic) || "",
            (node.visit.doctor && node.visit.doctor.name) || ""].filter(Boolean).join(" · ") }),
          el("div", { class: "opd-sub", text: prev ? "compared with " + visitLabel(prev.visit)
            : next ? "baseline column — struck text is dropped by " + next.visit.date : "" }),
        ]);
        head.style.borderTop = "3px solid " + colourFor(idx);
        cols.appendChild(head);
      });

      ["S", "O", "A", "P"].forEach((k) => {
        const texts = picked.map((node) => sectionTextOf(node, k));
        if (!texts.some(Boolean)) return;
        picked.forEach((node, idx) => {
          const text = texts[idx];
          const prev = idx > 0 ? picked[idx - 1] : null;
          const next = idx < n - 1 ? picked[idx + 1] : null;
          let body;
          if (!text) {
            body = el("div", { class: "opd-nochange", text: "section not in this note" });
          } else {
            const added = prev ? OPDLineage.diffRanges(sectionTextOf(prev, k), text).added : [];
            const removed = next ? OPDLineage.diffRanges(text, sectionTextOf(next, k)).removed : [];
            const marks = mergeRanges(text, added.map((r) => ({ start: r.start, end: r.end, kind: "add" }))
              .concat(removed.map((r) => ({ start: r.start, end: r.end, kind: "del" }))))
              .sort((a, b) => a.start - b.start);
            body = renderSectionBody(text, marks, (m) => (m.kind === "del"
              ? { colour: colourFor(idx + 1) }
              : { colour: colourFor(idx), wash: washFor(idx) }));
          }
          cols.appendChild(cell(idx, "rowtop", [el("h4", { text: k }), body]));
        });
      });

      const LANES = [
        ["Diagnoses added", (d) => d.diagnoses.added],
        ["Started", (d) => d.meds.started.map((m) => m.name + " (" + m.dose + ")")],
        ["Dose changed", (d) => d.meds.changed.map((m) => m.name + ": " + m.from + " → " + m.to)],
        ["Course ended", (d) => d.meds.ended.map((m) => m.name)],
        ["Pain", (d) => (d.pain.score == null ? []
          : [String(d.pain.score) + (d.pain.change ? " (" + (d.pain.change > 0 ? "+" : "") + d.pain.change + ")" : "")])],
        // The baseline column has nothing to its left, so it shows the anchor
        // value alone rather than a change against a visit that is not shown.
        ["Weight", (d, node) => {
          if (d.vitals.weight) {
            return [d.vitals.weight.to + " kg (" + (d.vitals.weight.delta > 0 ? "+" : "") + d.vitals.weight.delta + ")"];
          }
          const w = node.note.vitals && node.note.vitals.weight;
          return w == null ? [] : [w + " kg"];
        }],
      ];
      LANES.forEach((lane) => {
        const values = picked.map((node, idx) => lane[1](deltas[idx], node) || []);
        if (!values.some((v) => v.length)) return;
        picked.forEach((node, idx) => {
          cols.appendChild(cell(idx, "rowtop", [values[idx].length
            ? laneLine(lane[0], values[idx])
            : el("div", { class: "opd-nochange", text: "—" })]));
        });
      });

      wrap.appendChild(cols);
      return wrap;
    }

    function renderBlame() {
      const picked = selectedNodes();
      if (picked.length !== 1) {
        return el("div", { class: "opd-hint", text: "Select exactly one visit to see where each part of its note came from." });
      }
      const node = picked[0];
      const wrap = el("div", {});

      const controls = ["S", "O", "P"].map((k) => el("button", {
        class: "opd-tab", "aria-pressed": String(state.blameSection === k), text: k,
        onclick: () => { state.blameSection = k; renderMain(); },
      }));
      controls.push(el("button", {
        class: "opd-tab",
        text: state.blameGranularity === "line" ? "Detail: lines" : "Detail: words",
        onclick: () => {
          state.blameGranularity = state.blameGranularity === "line" ? "token" : "line";
          renderMain();
        },
      }));
      controls.push(el("button", {
        class: "opd-tab",
        text: state.blameShowRemoved ? "Removed text: shown" : "Removed text: hidden",
        onclick: () => { state.blameShowRemoved = !state.blameShowRemoved; renderMain(); },
      }));
      controls.push(el("span", {
        text: "Every run of text that ever appeared in this note's ancestry. Colour = the visit that wrote it; struck through = later removed.",
      }));
      wrap.appendChild(el("div", { class: "opd-legend" }, controls));

      /* Blame over a capture that is still arriving needs this warning, and it
       * is not a formality.
       *
       * Notes arrive NEWEST FIRST, so a note's ancestors land after it. Until
       * they do, every line looks original to the visit being read -- and blame
       * exists precisely to say which lines are new. Measured on one patient:
       * for the first five notes the newest note read as 100% written that day;
       * when its parent arrived that fell to 4%. Rendering that without saying
       * so would tell a clinician the opposite of the truth.
       *
       * Hence the grey below, and hence this line. Attribution is also not a
       * one-way settling: across that patient's whole load 143 attributions
       * moved to an older visit and 2 moved to a newer one, when an arriving
       * note re-pointed a parent and reshaped the chain. Rare, but it means
       * "provisional", not merely "incomplete". */
      if (streaming()) {
        const warn = el("div", { class: "opd-legend" }, [
          el("span", {
            text: "Still reading older visits (" + model.loaded + " of " +
                  (model.total || "?") + "). Text in grey is not yet traced — its " +
                  "origin may be a visit that has not been read. Attribution can " +
                  "still change in both directions until the read finishes.",
          }),
        ]);
        warn.style.color = "#9c640c";
        wrap.appendChild(warn);
      }

      const result = OPDLineage.blame(nodes, node.index, state.blameSection,
                                      { granularity: state.blameGranularity });
      if (!result.segments.length) {
        wrap.appendChild(el("div", { class: "opd-hint", text: "This section is empty in the whole chain." }));
        return wrap;
      }

      const chain = result.chain;
      const position = new Map();
      chain.forEach((c, i) => position.set(c.index, chain.length === 1 ? 1 : i / (chain.length - 1)));

      // Colour rides on the underline and a wash, never on the glyphs: jet's
      // midrange (yellow, cyan) is close to invisible as text on white.
      wrap.appendChild(el("div", { class: "opd-scale" }, chain.map((c) => {
        const t = position.get(c.index);
        const stop = el("span", { class: "opd-stop", text: c.date + (c.clinic ? " " + c.clinic : "") });
        stop.style.borderTop = "4px solid " + jetCss(t);
        stop.style.background = jetCss(t, 0.14);
        return stop;
      })));

      /* While the capture is still arriving, text credited to the OLDEST visit
       * read so far is exactly the text whose real origin is still unknown: the
       * chain root is only a root because nothing older has been fetched yet.
       * Those runs are drawn in grey with a dashed underline and make no claim
       * about a date. Everything mid-chain has a visit on both sides of it and
       * is shown normally. */
      const rootIndex = chain.length ? chain[0].index : null;
      const UNTRACED = "#8a949e";

      const pre = el("pre", { class: "opd-blame" });
      OPDLineage.blameRuns(result.segments)
        .filter((run) => state.blameShowRemoved || !run.removedAt)
        .forEach((run) => {
          const untraced = streaming() && run.addedIndex === rootIndex;
          const t = position.has(run.addedIndex) ? position.get(run.addedIndex) : 1;
          const span = el("span", {
            class: run.removedAt ? "opd-mark opd-del" : "opd-mark",
            title: untraced
              ? "not yet traced — older visits are still being read"
              : "written " + run.addedAt + (run.removedAt ? " · removed " + run.removedAt : ""),
            text: run.text,
          });
          if (untraced) {
            span.style.borderBottom = "2px dashed " + UNTRACED;
            if (run.removedAt) span.style.textDecorationColor = UNTRACED;
          } else {
            span.style.borderBottom = "2px solid " + jetCss(t);
            span.style.background = jetCss(t, run.removedAt ? 0.07 : 0.18);
            if (run.removedAt) span.style.textDecorationColor = jetCss(t);
          }
          pre.appendChild(span);
        });
      wrap.appendChild(el("div", { class: "opd-blame" }, [pre]));
      return wrap;
    }

    /* `keepScroll` is passed only by update(). A mode change or a new selection
     * should start at the top, but a rebuild triggered by a note arriving must
     * not yank the page out from under someone who is reading it. */
    function renderMain(keepScroll) {
      const at = keepScroll ? mainEl.scrollTop : 0;
      refreshHead();
      mainEl.textContent = "";
      mainEl.appendChild(state.mode === "course" ? renderCourse()
        : state.mode === "blame" ? renderBlame() : renderCompare());
      mainEl.scrollTop = at;
    }

    container.appendChild(buildHead());
    container.appendChild(el("div", { class: "opd-body" }, [buildPicker(), mainEl]));
    renderList();
    renderMain();

    return {
      renderMain,
      /* Swap in a newer model -- the next throttled rebuild of a capture that is
       * still arriving. Everything the reader has done (tab, selection, filters,
       * scroll) lives in `state` and the DOM, not in the model, so it survives.
       *
       * The clinic filter is rebuilt because a clinic the reader has never seen
       * can appear at any point in a read that runs newest-first. */
      update: (next) => {
        model = next;
        nodes = model.lineage.nodes;
        course = model.course;
        if (!state.userPicked) state.selected = new Set(defaultSelection());
        const picker = container.querySelector(".opd-picker");
        if (picker) picker.replaceWith(buildPicker());
        renderList();
        renderMain(true);
      },
      select: (keys) => {
        state.userPicked = true;
        state.selected = new Set(keys);
        renderList();
        renderMain();
      },
      setMode: (mode) => {
        state.mode = mode;
        Object.keys(tabButtons).forEach((k) => tabButtons[k].setAttribute("aria-pressed", String(k === mode)));
        renderMain();
      },
      state,
    };
  }

  const api = { mount, mergeRanges, lineSpans, jet, jetCss, version: 5 };
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.OPDView = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
