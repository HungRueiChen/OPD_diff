# OPD_diff

Outpatient notes are written by copying the previous note forward and editing it.
Read serially they are nearly identical, and the part that matters — what the
attending actually wrote *today* — is buried. OPD_diff surfaces that: it lines
visits up side by side, marks what each one added or dropped, and can attribute
every run of text in a note to the visit that first wrote it.

Built for the VGH Taipei HIS (`qemr`), and it runs as a browser extension on the
hospital workstation.

---

## What it does not do

This matters more than the feature list, so it comes first.

- **Read-only.** Every request is a GET. It never writes to the HIS.
- **Nothing leaves the machine.** All parsing and rendering happens in the
  browser, against the session the clinician already has open. There is no
  server, no upload, no telemetry, no network call to anywhere but the HIS.
- **It reads only what you can already see.** The extension asks the HIS for the
  same pages the logged-in user could open by hand.
- **It asserts nothing clinical.** Every line it shows is text quoted from a
  note, with its date and clinic. It does not summarise, infer or diagnose.

Requests are paced — 400–1000 ms between notes — because the HIS blocks IPs for
abnormal activity. A patient with a long history genuinely takes a minute or two
to read. The panel counts visits as it goes, so you can tell it apart from a hang.

---

## Installing on a ward machine

1. Copy the `extension/` folder to the machine.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `extension/` folder.

Chrome or Edge **109 or newer**. 109 is the last release for Windows 7, and the
extension is pinned to that floor.

If you update the extension later, press **Reload** on its card — the browser
caches file contents, and a newly copied file is not picked up otherwise.

### Using it

Open a patient's record in the HIS. A blue **OPD_diff** button appears in the
bottom-right corner.

| Tab | What it shows |
|---|---|
| **Compare** | Two or more visits side by side. Underlined text was added in that column; struck-through text is dropped by the next one. Everything — text and numbers alike — is measured against the column to its left. |
| **Blame** | One visit, with every run of text coloured by the visit that first wrote it, oldest blue through newest red. Removed text can be shown or hidden. |
| **Course (beta)** | A chronological timeline of what the attending newly wrote, with category chips. |

**Course is beta and labelled so.** The text it quotes is real, but the category
chips are frequently wrong: one sentence usually carries several categories at
once, and separating them reliably needs a language model. Read the chips as a
hint, never as a classification.

"Open in tab" hands the same view to a full browser tab, which reads better on a
wide screen.

---

## For developers

### Layout

| Path | |
|---|---|
| `src/` | The modules. **The single source of truth.** |
| `extension/` | The unpacked MV3 extension. `extension/lib/` is *copied* from `src/`. |
| `test/` | Offline harnesses, run against de-identified fixtures in a real browser. |
| `tools/` | De-identification, the PHI guard, and the extension build. |
| `deid/` | De-identified fixtures. Gitignored, and never committed. |

```
python tools/build_extension.py     # after editing anything in src/
```

Edit `src/`, never `extension/lib/` — the next build overwrites it. Bump
`OPDCapture.version` when behaviour changes; the console banner prints it, which
is how you tell which build is on a given machine.

### Tests

```
python test/deid_tests.py           # de-identification rules
python test/guard_tests.py          # the PHI guard
python tools/make_fixture_js.py     # bundle fixtures for the browser harnesses
python test/run_harness.py --summary   # parser/lineage/course over every fixture
python test/run_view.py --mode compare # render a tab in headless Chrome
```

`run_harness.py --summary` aggregates the whole corpus and then names only the
cases that look wrong. Run it after any change to the parsing modules.

### Patient data

Captured notes are real PHI and must never enter a repository, a chat window, or
any file that syncs off the machine.

```
python tools/deid.py apply <folder>     # de-identify a folder of captures
python tools/deid_verify.py --summary <folder>   # check what the rules MISSED
```

`tools/phi_guard.py` runs as a pre-read hook and blocks reading anything that
still carries identifiers, offering the de-identified twin instead. Both tools
must be invoked through Bash, bare — chaining, piping or redirection voids the
trusted-invocation exception.

De-identification **shifts** dates by a constant offset rather than removing
them, and pseudonyms are stable per patient, so a de-identified capture remains
valid input for visit-to-visit diffing.

**Do not write example identifiers into source comments.** A literal chart
number, staff code or date makes the guard block the file — including the edit
that would fix it. Write digits as `n`, and assemble literals at runtime in
tests.

---

## Known limits

- **Course-tab categories are unreliable.** See above. Revisit when a local
  language model is available to split multi-category sentences.
- **The HIS answers application errors with HTTP 200** and an error page body, so
  a failed request looks like a successful one. The capture layer throws when a
  visit list comes back without a table, and a batch stops after three
  consecutive failures, but keep it in mind when something looks empty.
- **A patient's chart number may appear hyphenated** (`nnnnnnn-n`, the last digit
  being a check digit). Both forms are accepted and normalised to the same
  patient.
- **No caching.** Reopening the panel re-reads every visit.
