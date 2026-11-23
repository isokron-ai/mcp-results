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
  assert.ok(doc.fields.every((f) => f.status === 'planned'));
});

test('rights: every TODO-verify is a deliberate marker, and none claims a licence it cannot show', () => {
  const doc = parseYaml(readFileSync(path.join(root, 'sources/rights.yaml'), 'utf8'));
  for (const s of doc.sources) {
    if (s.republish !== 'unknown') assert.notEqual(s.terms_url, 'TODO-verify', s.id);
  }
});
