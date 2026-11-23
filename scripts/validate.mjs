#!/usr/bin/env node
// Validates fields/registry.yaml and sources/rights.yaml against schema/*.json,
// plus the checks a schema cannot express (unique ids).
// Usage: node scripts/validate.mjs [repo-root]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseYaml } from './lib/miniyaml.mjs';
import { validate } from './lib/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(here, '..', 'schema');

const KINDS = {
  registry: { schema: 'registry.schema.json', list: 'fields' },
  rights: { schema: 'rights.schema.json', list: 'sources' },
};

export function validateFile(file, kind, { transform } = {}) {
  const spec = KINDS[kind];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return [`${file}: cannot read file (${e.code ?? e.message})`];
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return [`${file}: ${e.message}`];
  }
  if (transform) doc = transform(doc);
  const schema = JSON.parse(readFileSync(path.join(SCHEMAS, spec.schema), 'utf8'));
  const errs = validate(doc, schema).map((m) => `${file}: ${m}`);
  const list = doc?.[spec.list];
  if (Array.isArray(list)) {
    const seen = new Set();
    list.forEach((e, i) => {
      if (e && typeof e.id === 'string') {
        if (seen.has(e.id)) errs.push(`${file}: /${spec.list}/${i}/id: duplicate id "${e.id}"`);
        seen.add(e.id);
      }
    });
  }
  return errs;
}

export function validateAll(root) {
  const errors = [];
  const counts = {};
  for (const [kind, rel] of [['registry', 'fields/registry.yaml'], ['rights', 'sources/rights.yaml']]) {
    const file = path.join(root, rel);
    errors.push(...validateFile(file, kind));
    try {
      counts[kind] = parseYaml(readFileSync(file, 'utf8'))?.[KINDS[kind].list]?.length ?? 0;
    } catch {
      counts[kind] = 0;
    }
  }
  return { errors, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(here, '..'));
  const { errors, counts } = validateAll(root);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`\nvalidation failed: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`ok: ${counts.registry} registry fields, ${counts.rights} sources`);
}
