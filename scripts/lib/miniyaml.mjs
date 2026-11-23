// A small YAML reader for the simple shapes used in this repo.
//
// Supported: comments, block mappings, block sequences, flow maps `{a: 1}`,
// flow lists `[a, b]`, plain / single-quoted / double-quoted scalars, null,
// booleans, numbers. Not supported: anchors, tags, multi-line scalars,
// multiple documents. Anything else raises an error that names the line.

export class YamlError extends Error {}

const fail = (line, msg) => { throw new YamlError(`line ${line}: ${msg}`); };

function stripComment(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) {
        if (q === "'" && text[i + 1] === "'") i++;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s\[{,:]/.test(text[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function plainScalar(s) {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function skipSpaces(s, pos) {
  while (s[pos.i] === ' ') pos.i++;
}

function quoted(s, pos, line) {
  const q = s[pos.i++];
  let out = '';
  for (;;) {
    const c = s[pos.i];
    if (c === undefined) fail(line, 'unterminated quoted string');
    pos.i++;
    if (q === '"' && c === '\\') {
      const n = s[pos.i++];
      const map = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' };
      if (!(n in map)) fail(line, `unsupported escape \\${n}`);
      out += map[n];
    } else if (c === q) {
      if (q === "'" && s[pos.i] === "'") { out += "'"; pos.i++; } else return out;
    } else out += c;
  }
}

function flowKey(s, pos, line) {
  if (s[pos.i] === '"' || s[pos.i] === "'") {
    const k = quoted(s, pos, line);
    skipSpaces(s, pos);
    if (s[pos.i] !== ':') fail(line, 'expected ":" after key');
    pos.i++;
    return k;
  }
  const m = /^([^:,{}[\]]+?):(?=\s|$)/.exec(s.slice(pos.i));
  if (!m) fail(line, 'expected "key: value" in flow map');
  pos.i += m[0].length;
  return m[1].trim();
}

// Parse a flow value starting at s[pos.i]; moves pos.i past it.
function flowValue(s, pos, line, inFlow) {
  skipSpaces(s, pos);
  const c = s[pos.i];
  if (c === undefined) fail(line, 'unexpected end of value');
  if (c === '{') {
    pos.i++;
    const obj = {};
    for (;;) {
      skipSpaces(s, pos);
      if (s[pos.i] === '}') { pos.i++; return obj; }
      if (s[pos.i] === undefined) fail(line, 'unterminated flow map');
      const key = flowKey(s, pos, line);
      if (Object.hasOwn(obj, key)) fail(line, `duplicate key "${key}"`);
      obj[key] = flowValue(s, pos, line, true);
      skipSpaces(s, pos);
      if (s[pos.i] === ',') pos.i++;
      else if (s[pos.i] !== '}') fail(line, 'expected "," or "}" in flow map');
    }
  }
  if (c === '[') {
    pos.i++;
    const arr = [];
    for (;;) {
      skipSpaces(s, pos);
      if (s[pos.i] === ']') { pos.i++; return arr; }
      if (s[pos.i] === undefined) fail(line, 'unterminated flow list');
      arr.push(flowValue(s, pos, line, true));
      skipSpaces(s, pos);
      if (s[pos.i] === ',') pos.i++;
      else if (s[pos.i] !== ']') fail(line, 'expected "," or "]" in flow list');
    }
  }
  if (c === '"' || c === "'") return quoted(s, pos, line);
  const start = pos.i;
  while (pos.i < s.length && !(inFlow && /[,\]}]/.test(s[pos.i]))) pos.i++;
  return plainScalar(s.slice(start, pos.i).trim());
}

function inlineValue(text, line) {
  const pos = { i: 0 };
  const v = flowValue(text, pos, line, false);
  const left = text.slice(pos.i).trim();
  if (left !== '') fail(line, `unexpected text after value: "${left}"`);
  return v;
}

const isItem = (t) => /^-(\s|$)/.test(t);

export function parseYaml(source) {
  const lines = [];
  source.split(/\r?\n/).forEach((raw, idx) => {
    if (/\t/.test(raw.match(/^\s*/)[0])) fail(idx + 1, 'tabs are not allowed for indentation');
    const text = stripComment(raw).replace(/\s+$/, '');
    if (text.trim() === '') return;
    lines.push({ no: idx + 1, indent: text.match(/^ */)[0].length, text: text.trim() });
  });
  let i = 0;

  function block(indent) {
    const l = lines[i];
    if (l.indent !== indent) fail(l.no, `unexpected indentation (expected ${indent} spaces, found ${l.indent})`);
    return isItem(l.text) ? sequence(indent) : mapping(indent);
  }

  function sequence(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
      const l = lines[i];
      const rest = l.text.slice(1).trim();
      if (rest === '') {
        i++;
        arr.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
      } else if (/^[{["']/.test(rest) || !/^[^\s:][^:]*:(\s|$)/.test(rest)) {
        i++;
        arr.push(inlineValue(rest, l.no));
      } else {
        // "- key: value": the rest of the line starts a mapping.
        const inner = indent + (l.text.length - rest.length);
        lines[i] = { no: l.no, indent: inner, text: rest };
        arr.push(mapping(inner));
      }
    }
    return arr;
  }

  function mapping(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const l = lines[i];
      const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:{["'-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/.exec(l.text);
      if (!m) fail(l.no, `expected "key: value", found "${l.text}"`);
      const key = m[1][0] === '"' || m[1][0] === "'" ? inlineValue(m[1], l.no) : m[1];
      if (Object.hasOwn(obj, key)) fail(l.no, `duplicate key "${key}"`);
      i++;
      const rest = (m[2] ?? '').trim();
      if (rest !== '') {
        obj[key] = inlineValue(rest, l.no);
      } else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i].text)))) {
        obj[key] = block(lines[i].indent);
      } else {
        obj[key] = null;
      }
    }
    if (i < lines.length && lines[i].indent > indent) fail(lines[i].no, 'unexpected indentation');
    return obj;
  }

  if (lines.length === 0) return null;
  const result = block(lines[0].indent);
  if (i < lines.length) fail(lines[i].no, 'unexpected content');
  return result;
}
