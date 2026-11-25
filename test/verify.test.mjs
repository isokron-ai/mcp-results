import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, contentDigestOf, verifyData, verifyHistory } from '../scripts/verify.mjs';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const sample = path.join(here, 'fixtures', 'data-sample', 'data');
const sha = (d) => createHash('sha256').update(d).digest('hex');

/** A scratch repo root holding the real registry and a copy of the sample data. */
function root() {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-'));
  mkdirSync(path.join(dir, 'fields'));
  cpSync(path.join(repo, 'fields/registry.yaml'), path.join(dir, 'fields/registry.yaml'));
  cpSync(sample, path.join(dir, 'data'), { recursive: true });
  return { dir, data: (p) => path.join(dir, 'data', p), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const readJsonl = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** Rewrite a day file and keep the manifest's digests right, so only the change under test shows. */
function rewrite(r, rel, edit, { keepDigests = true } = {}) {
  const recs = readJsonl(r.data(rel));
  edit(recs);
  for (const x of recs) x.content_sha256 = contentDigestOf(x);
  const body = recs.map((x) => `${canonical(x)}\n`).join('');
  writeFileSync(r.data(rel), body);
  if (keepDigests) {
    const m = JSON.parse(readFileSync(r.data('manifest.json'), 'utf8'));
    const f = m.files.find((x) => x.path === rel);
    f.sha256 = sha(body); f.bytes = Buffer.byteLength(body); f.records = recs.length;
    writeFileSync(r.data('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  }
}
const problems = (r) => verifyData(r.dir).problems.join('\n');

test('R-RES-04: with no data folder the check passes (nothing is published yet)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-empty-'));
  try {
    assert.deepEqual(verifyData(dir).problems, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(path.join(repo, 'data')), false, 'this repository holds no data folder until the first reviewed batch is merged');
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/verify.mjs'), repo], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('R-RES-04: the sample the publisher builds from synthetic input verifies, and the command line says so', () => {
  const r = root();
  try {
    const res = verifyData(r.dir);
    assert.deepEqual(res.problems, []);
    assert.equal(res.records, 4);
    const cli = spawnSync(process.execPath, [path.join(repo, 'scripts/verify.mjs'), r.dir], { encoding: 'utf8' });
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /ok: 4 records in 3 files/);
  } finally { r.done(); }
});

test('R-RES-04: a consumer finds an edited record, a changed file, a stray file and a record in the wrong place', () => {
  let r = root();
  try {
    const f = 'results/live-probe/2026-11-24.jsonl';
    const text = readFileSync(r.data(f), 'utf8');
    writeFileSync(r.data(f), text.replace('"tool_count"', '"tool_count"').replace(/"value":3/, '"value":4'));
    assert.match(problems(r), /sha256 does not match the manifest/);
    assert.match(problems(r), /content_sha256 does not recompute/);
  } finally { r.done(); }
  r = root();
  try {
    writeFileSync(r.data('notes.txt'), 'x');
    writeFileSync(r.data('results/live-probe/2026-11-30.jsonl'), '');
    const p = problems(r);
    assert.match(p, /data\/notes\.txt: not a file this layout has/);
    assert.match(p, /2026-11-30\.jsonl: not listed in the manifest/);
  } finally { r.done(); }
  r = root();
  try {
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].measured.finished_at = '2026-11-26T10:00:00Z'; });
    assert.match(problems(r), /belongs in results\/live-probe\/2026-11-26\.jsonl/);
  } finally { r.done(); }
  r = root();
  try {
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].provenance.run_key = 'a'.repeat(64); });
    assert.match(problems(r), /record_id does not recompute from its provenance/);
  } finally { r.done(); }
});

test('R-RES-05: nothing is published that the registry does not publish today (class, status, undeclared)', () => {
  const r = root();
  try {
    const reg = readFileSync(path.join(r.dir, 'fields/registry.yaml'), 'utf8');
    const tightened = reg.replace(/(\{id: tool_count,[^}]*class: )P,/, '$1S,');
    assert.notEqual(tightened, reg);
    writeFileSync(path.join(r.dir, 'fields/registry.yaml'), tightened);
    assert.match(problems(r), /field tool_count \(class S, active\) is not published/);
    writeFileSync(path.join(r.dir, 'fields/registry.yaml'), reg);
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations.push({ field: 'ci_exploitable_trigger', value: {}, class: 'P', basis: 'measured' }); });
    assert.match(problems(r), /field ci_exploitable_trigger \(class S, planned\) is not published/);
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations = [{ field: 'made_up_field', value: 1, class: 'P', basis: 'measured' }]; });
    assert.match(problems(r), /made_up_field is not in the registry/);
  } finally { r.done(); }
});

test('R-RES-05: a secret, an email, or a combined score or verdict in a record is a problem', () => {
  const j = (...p) => p.join('');
  const r = root();
  try {
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations.push({ field: 'stderr_counts', value: { sample: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8') }, class: 'P', basis: 'measured' }); });
    assert.match(problems(r), /looks like it holds github-token/);
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations = [{ field: 'registry_name', value: j('maintainer', '@', 'some-company.io'), class: 'P', basis: 'measured' }]; });
    assert.match(problems(r), /holds email/);
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations = []; recs[0].coverage.score = 3; });
    assert.match(problems(r), /unexpected property|a key named "score"/);
  } finally { r.done(); }
});

test('R-RES-06: a skip that is our limit cannot be filed as the server\'s: the coverage state must say so', () => {
  const r = root();
  try {
    const f = 'results/scan-static/2026-11-24.jsonl';
    const [rec] = readJsonl(r.data(f));
    assert.equal(rec.coverage.state, 'unassessed_tool');
    assert.equal(rec.coverage.attribution, 'our_limit');
    rewrite(r, f, (recs) => { recs[0].coverage.state = 'subject'; recs[0].coverage.fault_side = 'subject'; recs[0].coverage.attribution = 'server_condition'; });
    assert.match(problems(r), /a skip of ours \(fault tool\) must make the state unassessed_tool/);
    rewrite(r, f, (recs) => { recs[0].coverage.state = 'assessed'; recs[0].coverage.fault_side = null; recs[0].coverage.attribution = 'assessed'; });
    assert.match(problems(r), /skips but coverage is assessed/);
  } finally { r.done(); }
});

test('R-RES-06: the manifest counts, per lane and by coverage state and fault side, recompute from the files', () => {
  const r = root();
  try {
    const m = JSON.parse(readFileSync(r.data('manifest.json'), 'utf8'));
    assert.deepEqual(m.lanes['scan-static'].coverage, { unassessed_tool: 1 });
    assert.deepEqual(m.lanes['scan-static'].fault_side, { tool: 1 });
    assert.deepEqual(m.lanes['live-probe'].coverage, { assessed: 2, subject: 1 });
    m.lanes['live-probe'].coverage.assessed = 3;
    writeFileSync(r.data('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    assert.match(problems(r), /per-lane counts do not recompute/);
    m.lanes['live-probe'].coverage.assessed = 2;
    m.totals.records = 9;
    writeFileSync(r.data('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    assert.match(problems(r), /totals do not recompute/);
  } finally { r.done(); }
});

test('R-RES-07: corrections: a retract keeps the record and names it, a purge needs the record gone, a supersede needs its replacement', () => {
  const r = root();
  try {
    const recs = ['results/live-probe/2026-11-24.jsonl', 'results/live-probe/2026-11-25.jsonl'].flatMap((f) => readJsonl(r.data(f)));
    const [a, b] = recs;
    const line = (c) => `${JSON.stringify({ schema: 'mcp-results/correction/1', note: 'test', corrected_at: '2026-11-26T08:00:00Z', ...c })}\n`;
    const setCorrections = (body, entries) => {
      writeFileSync(r.data('corrections.jsonl'), body);
      const m = JSON.parse(readFileSync(r.data('manifest.json'), 'utf8'));
      m.corrections = { path: 'corrections.jsonl', entries }; m.totals.corrections = entries;
      writeFileSync(r.data('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
    };
    // a retract: the record stays in its file, counts leave the manifest
    setCorrections(line({ kind: 'retract', target: a.record_id, replacement: null, reason: 'wrong_result' }), 1);
    let p = problems(r);
    assert.match(p, /per-lane counts do not recompute/, 'a retracted record is no longer counted');
    // a supersede must name a published replacement
    setCorrections(line({ kind: 'supersede', target: a.record_id, replacement: 'f'.repeat(64), reason: 'tool_defect' }), 1);
    assert.match(problems(r), /supersede needs a replacement that is published/);
    setCorrections(line({ kind: 'supersede', target: a.record_id, replacement: b.record_id, reason: 'tool_defect' }), 1);
    assert.doesNotMatch(problems(r), /supersede needs/);
    // a purge of a record still in the files is a problem; one that is gone is fine
    setCorrections(line({ kind: 'purge', target: a.record_id, replacement: null, reason: 'secret' }), 1);
    assert.match(problems(r), /is purged and must not be in the files/);
    setCorrections(line({ kind: 'purge', target: 'e'.repeat(64), replacement: null, reason: 'rights_claim' }), 1);
    assert.doesNotMatch(problems(r), /purged and must not/);
    // the manifest must count the file
    writeFileSync(r.data('corrections.jsonl'), line({ kind: 'purge', target: 'e'.repeat(64), replacement: null, reason: 'rights_claim' }) + line({ kind: 'purge', target: 'd'.repeat(64), replacement: null, reason: 'secret' }));
    assert.match(problems(r), /lists 1 corrections, the file has 2/);
  } finally { r.done(); }
});

test('R-RES-08: the history of the manifest chains: each one names the one it replaced, and an unchanged body keeps its chain', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-hist-'));
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  try {
    git('init', '-q');
    mkdirSync(path.join(dir, 'data'));
    const base = JSON.parse(readFileSync(path.join(sample, 'manifest.json'), 'utf8'));
    const write = (m) => { const s = `${JSON.stringify(m, null, 2)}\n`; writeFileSync(path.join(dir, 'data/manifest.json'), s); return s; };
    const m1 = { ...base, prev_manifest_sha256: null };
    const s1 = write(m1); git('add', '.'); git('commit', '-q', '-m', 'one');
    const m2 = { ...base, note: `${base.note} (revised)`, prev_manifest_sha256: sha(s1) };
    const s2 = write(m2); git('add', '.'); git('commit', '-q', '-m', 'two');
    assert.deepEqual(verifyHistory(dir), []);
    write({ ...m2, prev_manifest_sha256: sha('not the previous one') }); git('add', '.'); git('commit', '-q', '-m', 'bad');
    assert.match(verifyHistory(dir).join('\n'), /does not name the manifest it replaced/);
    assert.ok(s2.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Rebuild the manifest from the files, as a careful forger would, so only the append-only rule can catch the change. */
function regenManifest(r) {
  const m = JSON.parse(readFileSync(r.data('manifest.json'), 'utf8'));
  const gone = new Set();
  const lanes = {};
  const files = [];
  for (const old of m.files) {
    const f = r.data(old.path);
    if (!existsSync(f)) continue;
    const recs = readJsonl(f);
    if (!recs.length) { rmSync(f); continue; }
    const body = recs.map((x) => `${canonical(x)}\n`).join('');
    files.push({ ...old, records: recs.length, bytes: Buffer.byteLength(body), sha256: sha(body) });
    for (const x of recs) {
      if (gone.has(x.record_id)) continue;
      const l = (lanes[x.lane] ??= { records: 0, subjects: new Set(), coverage: {}, fault_side: {}, first: null, last: null });
      l.records += 1; l.subjects.add(x.subject.id);
      l.coverage[x.coverage.state] = (l.coverage[x.coverage.state] ?? 0) + 1;
      if (x.coverage.fault_side) l.fault_side[x.coverage.fault_side] = (l.fault_side[x.coverage.fault_side] ?? 0) + 1;
      const t = x.measured.finished_at;
      if (!l.first || t < l.first) l.first = t;
      if (!l.last || t > l.last) l.last = t;
    }
  }
  m.files = files;
  m.lanes = Object.fromEntries(Object.keys(lanes).sort().map((n) => [n, { records: lanes[n].records, subjects: lanes[n].subjects.size, coverage: Object.fromEntries(Object.entries(lanes[n].coverage).sort()), fault_side: Object.fromEntries(Object.entries(lanes[n].fault_side).sort()), first_finished_at: lanes[n].first, last_finished_at: lanes[n].last }]));
  m.totals = { records: Object.values(lanes).reduce((n, l) => n + l.records, 0), subjects: new Set(Object.values(lanes).flatMap((l) => [...l.subjects])).size, files: files.length, corrections: m.totals.corrections };
  writeFileSync(r.data('manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
}
const gitIn = (dir, ...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });

test('R-RES-09: published history is append-only: an edited or deleted record fails even with a manifest regenerated to match', async () => {
  const { verifyAppendOnly } = await import('../scripts/verify.mjs');
  const f = 'results/live-probe/2026-11-24.jsonl';
  for (const how of ['edit', 'delete']) {
    const r = root();
    try {
      gitIn(r.dir, 'init', '-q'); gitIn(r.dir, 'add', '.'); gitIn(r.dir, 'commit', '-q', '-m', 'one');
      const base = gitIn(r.dir, 'rev-parse', 'HEAD').stdout.trim();
      assert.deepEqual(verifyAppendOnly(r.dir, { base }), [], 'unchanged data is fine');
      if (how === 'edit') rewrite(r, f, (recs) => { recs[0].observations[0].value = 99; });
      else rewrite(r, f, (recs) => { recs.shift(); });
      regenManifest(r);
      assert.deepEqual(verifyData(r.dir).problems.filter((p) => !/not in the registry/.test(p)), [], 'the forged data is internally consistent');
      const p = verifyAppendOnly(r.dir, { base }).join('\n');
      assert.match(p, how === 'edit' ? /was changed after it was published/ : /was removed without a purge correction/);
      // history: commit it, and the walk finds it commit by commit
      gitIn(r.dir, 'add', '.'); gitIn(r.dir, 'commit', '-q', '-m', 'two');
      assert.match(verifyAppendOnly(r.dir, { history: true }).join('\n'), how === 'edit' ? /changed after/ : /removed without/);
    } finally { r.done(); }
  }
});

test('R-RES-09: a purge correction is the one way a record leaves; a correction line cannot be dropped', async () => {
  const { verifyAppendOnly } = await import('../scripts/verify.mjs');
  const r = root();
  try {
    gitIn(r.dir, 'init', '-q'); gitIn(r.dir, 'add', '.'); gitIn(r.dir, 'commit', '-q', '-m', 'one');
    const base = gitIn(r.dir, 'rev-parse', 'HEAD').stdout.trim();
    const f = 'results/live-probe/2026-11-24.jsonl';
    const [gone] = readJsonl(r.data(f));
    rewrite(r, f, (recs) => { recs.shift(); });
    writeFileSync(r.data('corrections.jsonl'), `${JSON.stringify({ schema: 'mcp-results/correction/1', kind: 'purge', target: gone.record_id, replacement: null, reason: 'secret', corrected_at: '2026-11-26T08:00:00Z' })}\n`);
    regenManifest(r);
    assert.deepEqual(verifyAppendOnly(r.dir, { base }), []);
    gitIn(r.dir, 'add', '.'); gitIn(r.dir, 'commit', '-q', '-m', 'purge');
    const base2 = gitIn(r.dir, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(r.data('corrections.jsonl'), '');
    assert.match(verifyAppendOnly(r.dir, { base: base2 }).join('\n'), /correction line was removed or edited/);
  } finally { r.done(); }
});

test('R-RES-10: a result whose fields were all left out cannot read as a clean assessment', () => {
  const r = root();
  try {
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations = []; });
    assert.match(problems(r), /assessed with no observations/);
  } finally { r.done(); }
});

test('R-RES-11: no position in the attempt is part of a record or its id, and the secret rules match the publisher\'s', () => {
  const r = root();
  try {
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].provenance.item_index = 2; });
    assert.match(problems(r), /item_index: unexpected property/);
    rewrite(r, 'results/live-probe/2026-11-24.jsonl', (recs) => { delete recs[0].provenance.item_index; recs[0].provenance.fence = 7; });
    assert.match(problems(r), /fence: unexpected property/);
  } finally { r.done(); }
  const j = (...p) => p.join('');
  for (const [name, v] of [['gitlab-pat', j('gl', 'pat-', 'a1B2c3D4e5F6g7H8i9J0')], ['stripe-secret-key', j('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0k1L2')], ['google-api-key', j('AI', 'za', 'Sy', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')], ['generic-sk-key', j('sk', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')], ['url-credentials', j('https://deploy', ':', 'hunter2hunter2', '@', 'example.org/x')]]) {
    const r2 = root();
    try {
      rewrite(r2, 'results/live-probe/2026-11-24.jsonl', (recs) => { recs[0].observations.push({ field: 'stderr_counts', value: { s: v }, class: 'P', basis: 'measured' }); });
      assert.match(problems(r2), new RegExp(`holds ${name}`), name);
    } finally { r2.done(); }
  }
});

test('R-RES-12: the fault side must not rank below a skip that states its fault, also when other skips state none; a manifest that disappears from history is a problem', () => {
  const r = root();
  try {
    const f = 'results/scan-static/2026-11-24.jsonl';
    rewrite(r, f, (recs) => { recs[0].coverage.skips.push({ stage: 'b', reason: 'trace_unavailable' }); recs[0].coverage.fault_side = 'infra'; recs[0].coverage.state = 'unassessed_infra'; recs[0].coverage.attribution = 'infrastructure'; });
    assert.match(problems(r), /must make the state unassessed_tool|ranks below the stated skip fault tool/);
    rewrite(r, f, (recs) => { recs[0].coverage.skips = [{ stage: 'a', reason: 'rate_limited', fault: 'infra' }, { stage: 'b', reason: 'x' }]; recs[0].coverage.fault_side = 'subject'; recs[0].coverage.state = 'subject'; recs[0].coverage.attribution = 'server_condition'; });
    assert.match(problems(r), /ranks below the stated skip fault infra/);
  } finally { r.done(); }
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-gone-'));
  try {
    gitIn(dir, 'init', '-q');
    mkdirSync(path.join(dir, 'data'));
    cpSync(path.join(sample, 'manifest.json'), path.join(dir, 'data/manifest.json'));
    gitIn(dir, 'add', '.'); gitIn(dir, 'commit', '-q', '-m', 'one');
    rmSync(path.join(dir, 'data/manifest.json')); gitIn(dir, 'add', '-A'); gitIn(dir, 'commit', '-q', '-m', 'gone');
    assert.match(verifyHistory(dir).join('\n'), /manifest\.json was removed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
