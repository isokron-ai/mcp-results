import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from '../scripts/lib/miniyaml.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { validateFile, validateAll } from '../scripts/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, 'fixtures', n);
const root = path.join(here, '..');

test('yaml: scalars, flow maps, lists, block maps, comments', () => {
  const doc = parseYaml(`# c
a: 1
b: "x # not comment"   # comment
c: [R1, 'two', null]
d: {k: v, n: -2.5, t: true}
e:
  - id: one
    n: 3
  - {id: two}
f: ~
`);
  assert.deepEqual(doc, {
    a: 1, b: 'x # not comment', c: ['R1', 'two', null],
    d: { k: 'v', n: -2.5, t: true },
    e: [{ id: 'one', n: 3 }, { id: 'two' }], f: null,
  });
});

test('yaml: syntax errors name the line', () => {
  assert.throws(() => parseYaml('a: 1\nb: {x: 1\n'), /line 2/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /line 2.*duplicate key/);
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /line 2/);
});

test('schema checker: type, enum, pattern, required, additionalProperties, items', () => {
  const s = {
    type: 'object', required: ['a'], additionalProperties: false,
    properties: { a: { type: 'string', pattern: '^x' }, b: { enum: [1, 2] }, c: { type: 'array', items: { type: 'integer' }, minItems: 1 } },
  };
  assert.deepEqual(validate({ a: 'xy', b: 1, c: [1] }, s), []);
  const errs = validate({ a: 'y', b: 3, c: [], z: 1 }, s).join('\n');
  assert.match(errs, /\/a: .*pattern/);
  assert.match(errs, /\/b: .*one of/);
  assert.match(errs, /\/c: .*at least 1/);
  assert.match(errs, /\/z: unexpected property/);
  assert.match(validate({}, s).join('\n'), /missing required property "a"/);
});

test('good registry fixture passes', () => {
  assert.deepEqual(validateFile(fx('registry-good.yaml'), 'registry'), []);
});

test('registry: bad class is reported with its path', () => {
  const errs = validateFile(fx('registry-bad-class.yaml'), 'registry').join('\n');
  assert.match(errs, /\/fields\/0\/class: .*one of/);
});

test('registry: duplicate ids, bad id format and unknown keys are reported', () => {
  assert.match(validateFile(fx('registry-dup-id.yaml'), 'registry').join('\n'), /duplicate id "sample_field"/);
  const errs = validateFile(fx('registry-bad-id.yaml'), 'registry').join('\n');
  assert.match(errs, /\/fields\/0\/id: .*pattern/);
  assert.match(errs, /\/fields\/1\/colour: unexpected property/);
});

test('good rights fixture passes', () => {
  assert.deepEqual(validateFile(fx('rights-good.yaml'), 'rights'), []);
});

test('rights: bad entry fails with clear messages', () => {
  const errs = validateFile(fx('rights-bad.yaml'), 'rights').join('\n');
  assert.match(errs, /\/sources\/0\/terms_url: .*pattern/);
  assert.match(errs, /\/sources\/0\/republish: .*one of/);
  assert.match(errs, /\/sources\/0: missing required property "reviewed_at"/);
});

test('rights: duplicate ids reported', () => {
  const errs = validateFile(fx('rights-good.yaml'), 'rights', { transform: (d) => { d.sources[1].id = d.sources[0].id; return d; } });
  assert.match(errs.join('\n'), /duplicate id "example-source"/);
});

test('a missing file is an error, not a crash', () => {
  assert.match(validateFile(fx('nope.yaml'), 'registry').join('\n'), /cannot read/);
});

test('the real registry and rights register are valid', () => {
  const r = validateAll(root);
  assert.deepEqual(r.errors, []);
  assert.ok(r.counts.registry > 100);
  assert.ok(r.counts.rights >= 10);
});

test('registry uses only the documented class letters', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const classes = new Set(doc.fields.map((f) => f.class));
  for (const c of classes) assert.ok(['P', 'P-s', 'P-h', 'P-t', 'PA', 'B', 'S', 'M', 'X'].includes(c), c);
  assert.ok(doc.fields.every((f) => ['planned', 'active'].includes(f.status)), 'nothing is deprecated yet');
});

// The fields merged worker code emits, whether or not its lane is enabled in the live loop (tool-qa
// pump/workflows.json says which are) (mcp-check corpus/scan-static.mjs observationsOf and
// corpus/live-probe.mjs FIELDS + TOOL_LIST_FIELDS + ORACLE_FIELDS; mcp-writecheck-action loop/summary.mjs; tool-qa meta/release-diff.mjs; tool-qa meta/github.mjs FIELDS + scorecard_api_result and
// meta/registry.mjs), and those tool-qa ingest sets for every result (R-COV-02).
const WRITTEN = {
  'scan-static': ['commit_sha', 'commit_date', 'registration_provenance'],
  'live-probe': ['subject_id', 'registry_name', 'registry_version', 'registry_package_register_type', 'registry_package_identifier',
    'registry_package_version', 'registry_package_transport', 'registry_package_runtime_hint', 'package_purl', 'oci_digest', 'transports_offered',
    'protocol_era', 'protocol_negotiated', 'client_version', 'server_info', 'capabilities_flags', 'capabilities_jcs_sha256', 'instructions_len_chars',
    'instructions_sha256', 'startup_ms', 'latency_cold_ms', 'startup_without_config', 'config_state', 'catalog_per_config_state', 'stdout_noise_lines',
    'stderr_counts', 'list_changed_notifications', 'pagination_behaviour', 'step_telemetry', 'sandbox_tier', 'runner_env', 'our_tool_versions',
    'observation_coverage', 'install_phase_behaviour', 'network_event', 'error_taxonomy_code', 'static_vs_live_agreement', 'commit_sha', 'commit_date',
    'tool_count', 'tool_list_sha256',
    // the oracle stage (corpus/live-probe.mjs ORACLE_FIELDS, EMIT_ORACLE_FIELDS on)
    'oracle_stage', 'sdk_client_results', 'conformance_suite', 'conformance_summary', 'conformance_checks', 'oracle_disagreements'],
  // mcp-writecheck-action loop/summary.mjs add(...)
  writecheck: ['tool_annotations_declared', 'safety_params', 'requirement_verdicts', 'plan_hash_and_drift', 'backend_version', 'conflict_behaviour',
    'annotation_completeness', 'annotation_honesty_behaviour_confirmed', 'idempotency_evidence_behaviour', 'idempotency_evidence_params', 'concurrency_guard_params'],
  // tool-qa meta/release-diff.mjs record(...)
  'release-diff': ['release_diff_summary', 'release_diff_findings', 'release_diff_held', 'release_artifacts'],
  'meta-github': ['repo_core', 'repo_owner_type', 'repo_popularity', 'owner_org_facts', 'releases_summary', 'issues_prs_summary',
    'contributors_counts', 'security_posture', 'branch_rules_public', 'community_profile', 'workflow_health', 'scorecard_api_result',
    'git_tag_targets', 'git_tag_map_sha256'],
  'meta-registry': ['registry_entry_history', 'npm_version_doc', 'npm_maintainer_count_and_change', 'npm_attestations', 'pypi_info',
    'pypi_project_status', 'pypi_provenance', 'crates_crate_facts', 'go_module_facts', 'depsdev_facts', 'oci_tag_digests'],
  'tool-qa ingest': ['fault_side', 'coverage_state'],
};

test('R-RES-01: the fields emitted by merged worker code (the lane may be disabled) are active, and only those; the rest stay planned', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const active = doc.fields.filter((f) => f.status === 'active').map((f) => f.id).sort();
  const written = [...new Set(Object.values(WRITTEN).flat())].sort();
  assert.deepEqual(active, written);
  // 357 on 23 Nov, + 6 live-probe oracle fields (#8), + 5 drift-signal fields (#9), + 4 release-diff fields,
  // + tool_names_sha256 (live-probe, planned until seen), + launch_retry (live-probe, planned until seen).
  assert.equal(doc.fields.length, 374);
  assert.equal(doc.fields.filter((f) => f.status === 'planned').length, 374 - written.length);
  // The header says what active means, and that it is not the live loop's lane state.
  const header = readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8').split('\nversion:')[0];
  assert.match(header, /active: seen in at least one accepted result/);
  assert.match(header, /pump\/workflows\.json/);
  assert.doesNotMatch(header, /written today/);
});

test('R-RES-02: fault_side and coverage_state are declared for the fault side tool-qa ingest records', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  for (const id of ['fault_side', 'coverage_state']) {
    const f = byId.get(id);
    assert.ok(f, id);
    assert.deepEqual([f.layer, f.type, f.source, f.class, f.redaction], ['tool_telemetry', 'enum', 'ingest-compact', 'P', null], id);
  }
  assert.ok(byId.has('fail_reason'), 'fail_reason stays for the per-stage detail');
});

test('R-RES-03: the drift signals are declared: tag targets and image digests per observation, and the moves derived from them', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  const want = {
    git_tag_targets: ['repo_ecosystem', 'object', 'meta-github', 'P'],
    git_tag_map_sha256: ['repo_ecosystem', 'hash', 'meta-github', 'P'],
    oci_tag_digests: ['repo_ecosystem', 'array', 'meta-registry', 'P'],
    git_tag_moves: ['longitudinal', 'array', 'ingest-compact', 'P'],
    oci_tag_moves: ['longitudinal', 'array', 'ingest-compact', 'P'],
    catalog_drift_same_version: ['longitudinal', 'object', 'ingest-compact', 'P-h'],
  };
  for (const [id, [layer, type, source, cls]] of Object.entries(want)) {
    const f = byId.get(id);
    assert.ok(f, id);
    assert.deepEqual([f.layer, f.type, f.source, f.class, f.redaction], [layer, type, source, cls, null], id);
    // Active once the code that emits them is merged (R-RES-01): the three observations are (tool-qa meta/github.mjs,
    // meta/registry.mjs); the moves are derived afterwards, and no merged code writes them as fields yet.
    assert.equal(f.status, ['git_tag_targets', 'git_tag_map_sha256', 'oci_tag_digests'].includes(id) ? 'active' : 'planned', id);
  }
});

test('rights: every TODO-verify is a deliberate marker, and none claims a licence it cannot show', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'sources/rights.yaml'), 'utf8'));
  for (const s of doc.sources) {
    if (s.republish !== 'unknown') assert.notEqual(s.terms_url, 'TODO-verify', s.id);
  }
});

test('the live-probe oracle stage fields are declared: SDK clients, the conformance suite, the stage and its disagreements', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  const want = {
    sdk_client_results: ['protocol', 'array', 'scan-live', 'P'],
    conformance_suite: ['protocol', 'object', 'scan-live', 'P'],
    conformance_summary: ['protocol', 'object', 'scan-live', 'P'],
    conformance_checks: ['protocol', 'array', 'scan-live', 'P'],
    oracle_stage: ['tool_telemetry', 'object', 'scan-live', 'P'],
    oracle_disagreements: ['tool_telemetry', 'array', 'scan-live', 'X'],
  };
  for (const [id, w] of Object.entries(want)) {
    const f = byId.get(id);
    assert.ok(f, id);
    assert.deepEqual([f.layer, f.type, f.source, f.class, f.redaction], [...w, null], id);
  }
});

test('the release-diff fields are declared: artifacts and summary public, findings after a human check, held security-class', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const byId = new Map(doc.fields.map((f) => [f.id, f]));
  const want = {
    release_artifacts: ['source_build', 'array', 'release-diff', 'P', 'R1'],
    release_diff_summary: ['source_build', 'array', 'release-diff', 'P', 'R1'],
    release_diff_findings: ['source_build', 'array', 'release-diff', 'P-h', 'R1'],
    release_diff_held: ['source_build', 'array', 'release-diff', 'S', 'R1'],
  };
  for (const [id, w] of Object.entries(want)) {
    const f = byId.get(id);
    assert.ok(f, id);
    const red = f.redaction === null || f.redaction === 'null' ? 'null' : f.redaction.join(',');
    assert.deepEqual([f.layer, f.type, f.source, f.class, red, f.status], [...w, 'active'], id);
  }
});

test('R-RES-13: the 24 fields found emitted by merged worker code while still planned (27 Nov: drift signals, oracle stage, release-diff, writecheck) are active; the unemitted fuzz and derived ones stay planned', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const status = new Map(doc.fields.map((f) => [f.id, f.status]));
  const emitted = ['git_tag_targets', 'git_tag_map_sha256', 'oci_tag_digests', 'release_artifacts', 'release_diff_summary', 'release_diff_findings', 'release_diff_held',
    'oracle_stage', 'sdk_client_results', 'conformance_suite', 'conformance_summary', 'conformance_checks', 'oracle_disagreements',
    'tool_annotations_declared', 'safety_params', 'requirement_verdicts', 'plan_hash_and_drift', 'backend_version', 'conflict_behaviour',
    'annotation_completeness', 'annotation_honesty_behaviour_confirmed', 'idempotency_evidence_behaviour', 'idempotency_evidence_params', 'concurrency_guard_params'];
  assert.equal(emitted.length, 24);
  for (const id of emitted) assert.equal(status.get(id), 'active', id);
  // list_determinism is written only while EMIT_FUZZ_FIELDS is on (off in mcp-check main); the moves are derived, not written
  for (const id of ['list_determinism', 'git_tag_moves', 'oci_tag_moves', 'catalog_drift_same_version']) assert.equal(status.get(id), 'planned', id);
});

test('R-RES-14: `active` means seen in accepted results, not read from code; a field whose emitter is merged but never seen carries that note', () => {
  const raw = readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8');
  const header = raw.split('\nversion:')[0];
  assert.match(header, /planned: not seen in any accepted result yet/);
  assert.match(header, /a field is not active on the strength of\n#\s+code/);
  assert.doesNotMatch(header, /active: emitted by merged worker code/);
  // list_determinism: emitter merged, switched off, in no accepted result (27 Nov scan of 18,834 accepted items)
  assert.match(raw, /# emitter merged \(mcp-check corpus\/live-probe\.mjs b4ed72a, EMIT_FUZZ_FIELDS off\), not yet seen in results\.\n  - \{id: list_determinism,/);
});

test('R-RES-15: tool_names_sha256 is declared for the live-probe lane: a hash in the protocol layer, planned until seen, next to tool_list_sha256', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const i = doc.fields.findIndex((f) => f.id === 'tool_names_sha256');
  assert.ok(i > 0);
  const f = doc.fields[i];
  assert.deepEqual([f.layer, f.type, f.unit, f.source, f.class, f.redaction, f.status], ['protocol', 'hash', 'none', 'scan-live', 'P', null, 'planned']);
  assert.equal(doc.fields[i - 1].id, 'tool_list_sha256');
});

test('R-RES-16: launch_retry is declared for the live-probe lane: an object in tool_telemetry, planned until seen', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'fields/registry.yaml'), 'utf8'));
  const f = doc.fields.find((x) => x.id === 'launch_retry');
  assert.ok(f);
  assert.deepEqual([f.layer, f.type, f.unit, f.source, f.class, f.redaction, f.status], ['tool_telemetry', 'object', 'none', 'scan-live', 'P', null, 'planned']);
});
