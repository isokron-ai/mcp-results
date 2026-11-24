# Regressions

Every problem found in this repository is pinned by a named test that stays in the suite for good. Tests are named
after their row (`R-RES-01: ...`).

New rows go at the end with the next free ID: the ID, what the problem was (severity first), the tests that pin it
(`file` › `test name`), and the commit(s) that fixed it.

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-RES-01 | LOW. Found by: loop assessment (doc drift), then review. Every field was `planned`, including the ones merged worker code emits, so the registry could not say what the code collects. Fields emitted by merged worker code (scan-static, live-probe, meta-github, meta-registry) or set by tool-qa ingest are now `active`. Active does not mean collected today: the lane may be disabled, and which lanes run is in tool-qa `pump/workflows.json`, not here. | `test/validate.test.mjs` › `R-RES-01: the fields emitted by merged worker code (the lane may be disabled) are active, and only those; the rest stay planned` | 558c363, 2f73cb9 |
| R-RES-02 | MEDIUM. Found by: loop assessment (L19). No field held the fault side or coverage state of a result, so our own limits could not be told from the server's in the dataset. `fault_side` and `coverage_state` are declared for what tool-qa ingest records (tool-qa R-COV-02). | `test/validate.test.mjs` › `R-RES-02: fault_side and coverage_state are declared for the fault side tool-qa ingest records` | 558c363 |
| R-RES-03 | LOW. Found by: loop tooling upgrades (item 10). The registry had no field for three drift signals: a git release tag whose target commit changes (force-push), an OCI tag that resolves to a new image digest, and a tool list that changes at an unchanged release. `git_tag_targets`, `git_tag_map_sha256` (meta-github) and `oci_tag_digests` (meta-registry) record what each observation sees; `git_tag_moves` and `oci_tag_moves` are the derived events, and `catalog_drift_same_version` is documented for the tool list. All stay `planned` until the tool-qa code that writes them is merged. | `test/validate.test.mjs` › `R-RES-03: the drift signals are declared: tag targets and image digests per observation, and the moves derived from them` | FIXME |
