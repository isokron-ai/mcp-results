// A minimal JSON Schema checker for the subset used by schema/*.json:
//   type (string or list), enum, const, pattern, minLength, minimum,
//   required, properties, additionalProperties (false only), items,
//   minItems, uniqueItems, and local "$ref" to "#/$defs/<name>".
// Annotation keywords ($schema, $id, $defs, title, description) are ignored.
// An unsupported validation keyword throws, so a schema cannot pass silently.

const IGNORED = new Set(['$schema', '$id', '$defs', 'title', 'description', 'examples', '$comment']);
const SUPPORTED = new Set([
  'type', 'enum', 'const', 'pattern', 'minLength', 'minimum', 'required',
  'properties', 'additionalProperties', 'items', 'minItems', 'uniqueItems', '$ref',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

const typeMatches = (v, t) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');

function resolve(ref, root) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m || !root.$defs?.[m[1]]) throw new Error(`cannot resolve $ref ${ref}`);
  return root.$defs[m[1]];
}

export function validate(value, schema, ptr = '', root = schema) {
  if (schema.$ref) return validate(value, resolve(schema.$ref, root), ptr, root);
  const errs = [];
  const at = ptr === '' ? '/' : ptr;
  for (const k of Object.keys(schema)) {
    if (!IGNORED.has(k) && !SUPPORTED.has(k)) throw new Error(`schema keyword not supported by the checker: ${k}`);
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(value, t))) {
      errs.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errs;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(value)})`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      errs.push(`${at}: does not match pattern ${schema.pattern} (got ${JSON.stringify(value)})`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: must have at least ${schema.minLength} characters`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: must be at least ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: must have at least ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${at}: items must be unique`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${ptr}/${i}`, root)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(value, r)) errs.push(`${at}: missing required property "${r}"`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) errs.push(...validate(v, props[k], `${ptr}/${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${ptr}/${k}: unexpected property`);
    }
  }
  return errs;
}
