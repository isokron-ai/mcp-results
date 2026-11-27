# mcp-results

This repository will hold the results of IsoKron's tool-qa loop: our measurements of open-source MCP servers. Each result will say what we measured, how, with which tool version, and when.

**Status: not publishing yet. This repository holds schemas and registers only.** There is no data here. Nothing in it has been collected for release, and nothing should be read as a finding about any server. The path that will publish results (format, checker, corrections) is built and switched off; see [docs/DATA.md](docs/DATA.md).

## What is here

| Path | What it is |
|---|---|
| `fields/registry.yaml` | The field registry: every field we capture or plan to capture, with its type, unit, source and publish class. Fields seen in at least one accepted result of the live loop (written by a merged worker or set by tool-qa ingest) are `active`, though the lane may be disabled (see tool-qa `pump/workflows.json`); the rest are `planned`, even when their emitter is merged. |
| `sources/rights.yaml` | The source-rights register: each outside source we read, the terms that apply, and what we may republish. Unknowns are marked `unknown` or `TODO-verify`. |
| `schema/` | JSON Schemas (draft 2020-12) for the two files above. |
| `scripts/validate.mjs` | Checks both files against the schemas. No dependencies. Needs Node 22 or later. |
| `schema/record.schema.json`, `manifest.schema.json`, `correction.schema.json` | The shape of the published data: one result per line, the manifest, and corrections. |
| `scripts/verify.mjs` | Checks the published data under `data/` the way a consumer can: digests, schemas, the registry, coverage, corrections. Passes when there is no `data/` yet. |
| `docs/DATA.md` | The data format, what is and is not published, how to check it, and how corrections work. |
| `docs/METHODOLOGY.md` | A stub. It will be written before the first release. |

Run the checks with:

```
node --test 'test/*.test.mjs'
node scripts/validate.mjs
node scripts/verify.mjs
```

## Licences

- **Data:** our own measurements will be released under [CC BY 4.0](LICENSE-DATA).
- **Code:** MIT. See [LICENSE](LICENSE).
- **Third-party material keeps its own terms and is not covered by our licence.** That includes text written by the authors of the servers we test (tool descriptions, READMEs, schemas with descriptive text) and data we read from other sources. Where the upstream licence allows it, that text may be republished with its licence and a source link. Otherwise we publish only hashes, lengths and our own derived features.

## Corrections

If a published result is wrong, anyone will be able to report it through an issue form in this repository. A correction adds a new row that replaces the old one, and the history keeps both. A result can also be withdrawn, and data that is personal, a secret, or subject to a rights claim will be removed from past releases too. The details will be set out before the first release.

## About

Built by [IsoKron](https://isokron.ai/?utm_source=mcp-results&utm_medium=readme).
