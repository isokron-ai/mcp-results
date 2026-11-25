#!/usr/bin/env node
// Verifies the published data in data/ the way a consumer can: from the files, the
// schemas and the field registry, with no network and no dependencies.
//
//   node scripts/verify.mjs [repo-root] [--history]
//
// Checks, in this order (every problem is listed; exit 1 if there is any):
//   1. data/ holds only manifest.json, corrections.jsonl and results/<lane>/<day>.jsonl
//   2. each file is listed in the manifest with the sha256, byte count and record count it has
//   3. every record passes schema/record.schema.json; its record_id recomputes from its
//      provenance (sha256 of "<attempt_id>\n<item_index>\n<run_key>"); its content_sha256
//      recomputes from the canonical form of the record; the line is that canonical form;
//      it sits in the file named by its lane and the UTC day it finished; files are in
//      (finished_at, record_id) order; no id appears twice
//   4. every observation is a field the registry (fields/registry.yaml) publishes today:
//      active, class P or P-s, with the class and basis the registry gives it. Security
//      classes (S, M), held classes (P-h, P-t, PA, B, X) and planned fields fail here
//   5. no value looks like a secret or an email, and no record-level key is a combined
//      score or a verdict
//   6. coverage is consistent: a skip that is our limit (fault tool) means the state is
//      unassessed_tool, never the server's; no skips means assessed
//   7. the manifest's totals and per-lane counts recompute from the files
//   8. corrections: supersede and retract name records that exist, a supersede names its
//      replacement, a purge names a record that is gone
//   --history  also walks the git history of data/manifest.json and checks the chain
//              (prev_manifest_sha256) from the first version to the last
//
// With no data/ folder it passes: nothing is published yet.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from './lib/miniyaml.mjs';
import { validate } from './lib/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(here, '..', 'schema');
const schema = (n) => JSON.parse(readFileSync(path.join(SCHEMAS, n), 'utf8'));
const sha256 = (d) => createHash('sha256').update(d).digest('hex');

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const recordIdOf = (p) => sha256(`${p.attempt_id}\n${p.item_index}\n${p.run_key}`);
export const contentDigestOf = (record) => { const { content_sha256: _d, ...rest } = record; return sha256(canonical(rest)); };

const DAY_FILE = /^results\/([a-z0-9][a-z0-9-]{0,63})\/(\d{4}-\d{2}-\d{2})\.jsonl$/;
const COMBINED = new Set(['score', 'scores', 'grade', 'grades', 'rating', 'ratings', 'rank', 'ranking', 'overall', 'composite', 'combined', 'pass', 'passed', 'fail', 'failed', 'verdict']);
const COVERAGE = { assessed: [null, 'assessed'], unassessed_tool: ['tool', 'our_limit'], unassessed_unknown: ['unknown', 'not_stated'], unassessed_infra: ['infra', 'infrastructure'], subject: ['subject', 'server_condition'], excluded: ['policy', 'our_policy'] };
const FAULT_ORDER = ['tool', 'unknown', 'infra', 'subject', 'policy'];
const RESERVED_EMAIL = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;
// A small subset of tool-qa's redaction rules, as a last check on what is published.
const SECRET_RULES = [
  ['private-key-block', /-----BEGIN (?:[A-Z0-9]{1,32} ){0,8}PRIVATE KEY(?: BLOCK)?-----/],
  ['age-secret-key', /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}/],
  ['aws-access-key-id', /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/],
  ['github-fine-grained-pat', /\bgithub_pat_[A-Za-z0-9_]{82}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['canary', /ISOKRON_CANARY_[A-Za-z0-9]{8,}/],
];
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@((?:[A-Za-z0-9-]{1,63}\.){1,16}[A-Za-z]{2,63})\b/g;

function strings(value, out = []) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { out.push(k); stack.push(x); } }
  }
  return out;
}
function secretRules(value) {
  const hits = new Set();
  for (const s of strings(value)) {
    for (const [id, re] of SECRET_RULES) if (re.test(s)) hits.add(id);
    for (const m of s.matchAll(EMAIL)) if (!RESERVED_EMAIL.test(m[2])) hits.add('email');
  }
  return [...hits];
}
function keysOf(value, out = new Set()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  else if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  return out;
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/** @returns {{problems: string[], records: number, files: number}} */
export function verifyData(root, { registryPath } = {}) {
  const problems = [];
  const dataDir = path.join(root, 'data');
  if (!existsSync(dataDir)) return { problems, records: 0, files: 0 };
  const reg = parseYaml(readFileSync(registryPath ?? path.join(root, 'fields/registry.yaml'), 'utf8'));
  const fields = new Map(reg.fields.map((f) => [f.id, f]));
  const recordSchema = schema('record.schema.json');

  const present = walk(dataDir);
  for (const rel of present) if (rel !== 'manifest.json' && rel !== 'corrections.jsonl' && !DAY_FILE.test(rel)) problems.push(`data/${rel}: not a file this layout has`);
  if (!present.includes('manifest.json')) { problems.push('data/manifest.json: missing'); return { problems, records: 0, files: 0 }; }
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')); } catch { problems.push('data/manifest.json: not JSON'); return { problems, records: 0, files: 0 }; }
  const bad = validate(manifest, schema('manifest.schema.json')).map((m) => `manifest.json${m}`);
  if (bad.length) return { problems: [...problems, ...bad], records: 0, files: 0 };

  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const rel of present.filter((p) => DAY_FILE.test(p))) if (!listed.has(rel)) problems.push(`data/${rel}: not listed in the manifest`);
  const records = new Map();
  const live = new Map(); // path -> records
  for (const f of manifest.files) {
    const file = path.join(dataDir, f.path);
    if (!existsSync(file)) { problems.push(`data/${f.path}: listed in the manifest but missing`); continue; }
    const bytes = readFileSync(file);
    if (sha256(bytes) !== f.sha256) problems.push(`data/${f.path}: sha256 does not match the manifest`);
    if (bytes.length !== f.bytes) problems.push(`data/${f.path}: ${bytes.length} bytes, the manifest says ${f.bytes}`);
    const lines = bytes.toString('utf8').split('\n').filter((l) => l !== '');
    if (lines.length !== f.records) problems.push(`data/${f.path}: ${lines.length} records, the manifest says ${f.records}`);
    let prev = null;
    const recs = [];
    lines.forEach((line, i) => {
      const at = `data/${f.path}:${i + 1}`;
      let r;
      try { r = JSON.parse(line); } catch { problems.push(`${at}: not JSON`); return; }
      const errs = validate(r, recordSchema);
      if (errs.length) { problems.push(...errs.slice(0, 5).map((m) => `${at}${m}`)); return; }
      if (line !== canonical(r)) problems.push(`${at}: not in canonical form`);
      if (r.record_id !== recordIdOf(r.provenance)) problems.push(`${at}: record_id does not recompute from its provenance`);
      if (r.content_sha256 !== contentDigestOf(r)) problems.push(`${at}: content_sha256 does not recompute`);
      if (records.has(r.record_id)) problems.push(`${at}: record_id ${r.record_id} appears twice`);
      records.set(r.record_id, r);
      recs.push(r);
      const day = new Date(r.measured.finished_at).toISOString().slice(0, 10);
      if (r.lane !== f.lane || day !== f.day) problems.push(`${at}: belongs in results/${r.lane}/${day}.jsonl`);
      const key = `${r.measured.finished_at}\u0000${r.record_id}`;
      if (prev !== null && key < prev) problems.push(`${at}: out of (finished_at, record_id) order`);
      prev = key;
      checkRecord(r, at);
    });
    live.set(f.path, recs);
  }

  function checkRecord(r, at) {
    const seen = new Set();
    for (const o of r.observations) {
      const e = fields.get(o.field);
      if (!e) { problems.push(`${at}: field ${o.field} is not in the registry`); continue; }
      if (e.status !== 'active' || !['P', 'P-s'].includes(e.class)) problems.push(`${at}: field ${o.field} (class ${e.class}, ${e.status}) is not published`);
      else if (o.class !== e.class || o.basis !== (e.class === 'P-s' ? 'read_from_source' : 'measured')) problems.push(`${at}: field ${o.field} carries class ${o.class}/${o.basis}, the registry says ${e.class}`);
      if (o.value === null && o.why === undefined) problems.push(`${at}: field ${o.field} is null without a reason`);
      const k = `${o.field}\u0000${canonical(o)}`;
      if (seen.has(k)) problems.push(`${at}: field ${o.field} is listed twice with the same content`);
      seen.add(k);
    }
    const hits = secretRules(r);
    if (hits.length) problems.push(`${at}: looks like it holds ${hits.join(', ')}`);
    const { observations: _o, ...rest } = r;
    for (const k of keysOf(rest)) if (COMBINED.has(k)) problems.push(`${at}: a key named "${k}": results are separate measurements, never one score or a verdict`);
    const [fault, attribution] = COVERAGE[r.coverage.state];
    if (r.coverage.fault_side !== fault || r.coverage.attribution !== attribution) problems.push(`${at}: coverage ${r.coverage.state} does not go with fault side ${r.coverage.fault_side} and attribution ${r.coverage.attribution}`);
    if (r.coverage.skips.length === 0 && r.coverage.state !== 'assessed') problems.push(`${at}: no skips but coverage is ${r.coverage.state}`);
    if (r.coverage.skips.length > 0 && r.coverage.state === 'assessed') problems.push(`${at}: skips but coverage is assessed`);
    if (r.coverage.skips.some((s) => s.fault === 'tool') && r.coverage.state !== 'unassessed_tool') problems.push(`${at}: a skip of ours (fault tool) must make the state unassessed_tool, not ${r.coverage.state}`);
    if (r.coverage.skips.length && r.coverage.skips.every((s) => s.fault)) {
      const f = FAULT_ORDER.find((x) => r.coverage.skips.some((s) => s.fault === x));
      if (f !== undefined && r.coverage.fault_side !== f) problems.push(`${at}: fault side ${r.coverage.fault_side}, the skips say ${f}`);
    }
  }

  // corrections
  const corrections = [];
  if (present.includes('corrections.jsonl')) {
    readFileSync(path.join(dataDir, 'corrections.jsonl'), 'utf8').split('\n').filter((l) => l !== '').forEach((line, i) => {
      const at = `data/corrections.jsonl:${i + 1}`;
      let c;
      try { c = JSON.parse(line); } catch { problems.push(`${at}: not JSON`); return; }
      const errs = validate(c, schema('correction.schema.json'));
      if (errs.length) { problems.push(...errs.map((m) => `${at}${m}`)); return; }
      corrections.push(c);
      if (c.kind === 'purge' && records.has(c.target)) problems.push(`${at}: record ${c.target} is purged and must not be in the files`);
      if (c.kind !== 'purge' && !records.has(c.target)) problems.push(`${at}: ${c.kind} names record ${c.target}, which is not published`);
      if (c.kind === 'supersede' && (!c.replacement || !records.has(c.replacement))) problems.push(`${at}: supersede needs a replacement that is published`);
      if (c.kind !== 'supersede' && c.replacement !== null) problems.push(`${at}: only a supersede has a replacement`);
    });
  }
  if ((manifest.corrections?.entries ?? 0) !== corrections.length) problems.push(`manifest.json: lists ${manifest.corrections?.entries ?? 0} corrections, the file has ${corrections.length}`);

  // totals recompute
  const gone = new Set(corrections.filter((c) => c.kind === 'retract' || c.kind === 'purge').map((c) => c.target));
  const lanes = {};
  for (const recs of live.values()) for (const r of recs) {
    if (gone.has(r.record_id)) continue;
    const l = (lanes[r.lane] ??= { records: 0, subjects: new Set(), coverage: {}, fault_side: {}, first: null, last: null });
    l.records += 1; l.subjects.add(r.subject.id);
    l.coverage[r.coverage.state] = (l.coverage[r.coverage.state] ?? 0) + 1;
    if (r.coverage.fault_side) l.fault_side[r.coverage.fault_side] = (l.fault_side[r.coverage.fault_side] ?? 0) + 1;
    const t = r.measured.finished_at;
    if (!l.first || t < l.first) l.first = t;
    if (!l.last || t > l.last) l.last = t;
  }
  const expectLanes = Object.fromEntries(Object.keys(lanes).sort().map((n) => [n, {
    records: lanes[n].records, subjects: lanes[n].subjects.size,
    coverage: Object.fromEntries(Object.entries(lanes[n].coverage).sort()), fault_side: Object.fromEntries(Object.entries(lanes[n].fault_side).sort()),
    first_finished_at: lanes[n].first, last_finished_at: lanes[n].last,
  }]));
  if (canonical(manifest.lanes) !== canonical(expectLanes)) problems.push('manifest.json: the per-lane counts do not recompute from the files');
  const all = new Set(Object.values(lanes).flatMap((l) => [...l.subjects]));
  const total = Object.values(lanes).reduce((n, l) => n + l.records, 0);
  const t = manifest.totals;
  if (t.records !== total || t.subjects !== all.size || t.files !== manifest.files.length || t.corrections !== corrections.length) problems.push('manifest.json: totals do not recompute from the files');
  return { problems, records: records.size, files: manifest.files.length };
}

/** The chain of data/manifest.json through git history: each prev_manifest_sha256 names the manifest it replaced. */
export function verifyHistory(root, run = spawnSync) {
  const problems = [];
  const git = (...a) => run('git', ['-C', root, ...a], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const log = git('log', '--reverse', '--format=%H', '--', 'data/manifest.json');
  if (log.status !== 0) return ['git history of data/manifest.json could not be read'];
  const commits = log.stdout.toString().split('\n').filter(Boolean);
  let before = null;
  for (const c of commits) {
    const show = git('show', `${c}:data/manifest.json`);
    if (show.status !== 0) continue; // the file was removed in this commit
    const bytes = show.stdout;
    let m;
    try { m = JSON.parse(bytes.toString('utf8')); } catch { problems.push(`${c.slice(0, 12)}: manifest.json is not JSON`); continue; }
    if (before === null) {
      if (m.prev_manifest_sha256 !== null) problems.push(`${c.slice(0, 12)}: the first manifest has a prev_manifest_sha256`);
    } else {
      const strip = (x) => canonical({ ...x, prev_manifest_sha256: null });
      const expected = strip(before.m) === strip(m) ? before.m.prev_manifest_sha256 : sha256(before.bytes);
      if (m.prev_manifest_sha256 !== expected) problems.push(`${c.slice(0, 12)}: prev_manifest_sha256 does not name the manifest it replaced`);
    }
    before = { m, bytes };
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const history = args.includes('--history');
  const root = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(here, '..'));
  const r = verifyData(root);
  const problems = [...r.problems, ...(history ? verifyHistory(root) : [])];
  if (problems.length) {
    for (const p of problems.slice(0, 200)) console.error(p);
    console.error(`\nverification failed: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(r.files === 0 && !existsSync(path.join(root, 'data')) ? 'ok: no data published yet' : `ok: ${r.records} records in ${r.files} files`);
}
