# The published data

This is the format of the data that will appear under `data/` once publishing is switched on, and how to check it. There is no data in this repository yet.

The results come from IsoKron's tool-qa loop. Each record is one result that tool-qa's ingest accepted: which tool version measured which server, and when. Records are separate measurements. There is no score, no grade and no pass/fail, and nothing combines them.

## Layout

| Path | What it is |
|---|---|
| `data/manifest.json` | Every data file with its sha256, byte count and record count. Totals, and for each lane the number of records, the number of servers, the coverage by state and by fault side, and the first and last time measured. The version and digest of the field registry the run used, and the digest of the manifest it replaced. |
| `data/results/<lane>/<YYYY-MM-DD>.jsonl` | One record per line, for one lane and the UTC day the result finished. Sorted by finish time, then record id. A late result joins the file of its own day. |
| `data/corrections.jsonl` | Corrections and retractions. Append-only. See below. |

A lane is the tool-qa workflow that measured: `live-probe`, `scan-static`, `meta-github`, and so on. Each lane is a separate claim about a server; see tool-qa's `docs/MEASUREMENTS.md`.

Every file is written in one canonical form (keys sorted, no spaces), so the same records are always the same bytes.

## A record

The shape is `schema/record.schema.json`.

| Part | What it says |
|---|---|
| `record_id` | sha256 of `<attempt_id>\n<item_index>\n<run_key>`. The same result always has the same id. |
| `lane`, `subject` | The lane, and the server: its registry id, its repository and the commit that was read. Published by company and repository name. |
| `measured` | When the run started and finished. |
| `provenance` | Where the result came from: the run key and attempt that tool-qa dispatched, the item, the fence, the worker workflow (repository, file, commit, run id), the tool and oracle versions used and a digest of the settings. The worker run is a public GitHub Actions run in the named repository. |
| `coverage` | Whether the server was assessed, and if not, whose limit it was. See below. |
| `observations` | The measurements: `{field, value, class, basis}`. `field` is an id in `fields/registry.yaml`. `class` is the registry class (P or P-s); `basis` is `measured`, or `read_from_source` for P-s. `masked: true` means a secret-looking span in text written by the server's author was replaced. A `null` value comes with `why`. |
| `content_sha256` | sha256 of the canonical record without this field. |

### Coverage: separate from the measurements, never a failure

`coverage.state` is one of `assessed`, `unassessed_tool`, `unassessed_unknown`, `unassessed_infra`, `subject` and `excluded`; `fault_side` and `attribution` go with it:

| state | fault side | attribution | Meaning |
|---|---|---|---|
| `assessed` | none | `assessed` | No stage was skipped. |
| `unassessed_tool` | tool | `our_limit` | Our tool could not do the check (language or layout we do not read, a size cap, an error of ours). The server is not marked down for it. |
| `unassessed_unknown` | unknown | `not_stated` | A skip whose fault was not stated; counted with ours. |
| `unassessed_infra` | infra | `infrastructure` | A rate limit or outage outlasted the retries. |
| `subject` | subject | `server_condition` | A property of the server (needs credentials, does not build). Still not a verdict. |
| `excluded` | policy | `our_policy` | We chose not to run it. |

When a result has several skips, our own limit wins: one skip of ours makes the state `unassessed_tool`. `coverage.skips` lists each skip: stage, reason, who it is down to, and whether it can be retried. A server with no record has not been measured in that lane; that is not a result.

## What is published, and what is not

A field is published only if the registry marks it `active` and class `P` or `P-s`. Fields of class P-h, B (until a person has confirmed them), P-t (text written by the server's author, unless a licence decision says otherwise), PA (aggregates only), X, S and M are not in the records. A security-class result (S, M) is held back whole until its disclosure window ends, and nothing in the data, the manifest or the logs says that it exists. Tool reports, captured server output and logs from the runs are never published, only the registry fields. See tool-qa `docs/PUBLISHING.md` for how.

## Check it yourself

```
node scripts/verify.mjs            # the files, the schemas, the registry
node scripts/verify.mjs --history  # also the chain of manifests through git history
```

It needs Node 22 or later and no packages. It checks that:

1. `data/` has only the manifest, the corrections and the day files;
2. each file has the sha256, byte count and record count the manifest gives;
3. each record passes the schema; its `record_id` and `content_sha256` recompute; it is in canonical form, in the file of its lane and day, in order, and no id is repeated;
4. every observation is a field the registry publishes today, with the class the registry gives it;
5. no value looks like a secret or an email, and no key is a score or a verdict;
6. a skip that is our limit makes the state `unassessed_tool`;
7. the manifest totals and per-lane counts recompute from the files;
8. each correction points at what it should (below).

To trace one record to its run: the `provenance.workflow` names the worker repository and the run id (`https://github.com/<repo>/actions/runs/<run_id>`). Commits that add data are made through the GitHub API by the loop and show as verified. The manifest of each commit names the one it replaced (`prev_manifest_sha256`), so removing a batch from history is visible.

## Corrections and withdrawals

Published records are never edited. A correction is a line in `data/corrections.jsonl` (`schema/correction.schema.json`):

| kind | Effect |
|---|---|
| `supersede` | The target record is replaced by another published record (`replacement`). Both stay in the files; consumers use the replacement. |
| `retract` | The target stays in its file, and consumers must ignore it. It no longer counts in the manifest. |
| `purge` | For a secret, personal data, a rights claim or a security hold: the record is removed from the files, and from earlier releases as the repository's history allows. Only its id and the reason remain. |

The publisher never brings back a retracted or purged record from an older sealed result. If the registry later stops publishing a field that is already in the data, the publisher stops and nothing more is published until a person has corrected it.

A new result for the same server and lane is not a correction. It is a new measurement, kept next to the old one.

Data licence: CC BY 4.0 ([LICENSE-DATA](../LICENSE-DATA)). Text written by the servers' authors keeps its own terms. See the README.
