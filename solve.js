// Fast drop-in for makefun-site 1.0.0: same answers, one tight engine.
// Single file, no dependencies. Design: no token objects in Markdown
// (blocks render straight into an output array), inline rendering flushes
// plain runs through one bulk escape instead of escaping char by char,
// slugs are cached per build with an ASCII fast path, templates are parsed
// once into flat node arrays and rendered by a small interpreter that
// writes into a shared output array.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TEST = /[&<>"']/;

function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Per-build slug cache (fresh for every run, never shared across cases). */
let slugCache = null;

function slugOfText(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  let out = '';
  let gap = false;
  // Fast path: NFKD is the identity on ASCII, and ASCII holds no combining
  // marks, so a pure-ASCII string can be slugged without normalising.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw[i])) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      const parts = raw.split('-');
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.length === 0) return { error: 'key "slug": not a slug' };
        for (let j = 0; j < p.length; j++) {
          const c = p[j];
          if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return { error: 'key "slug": not a slug' };
        }
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const len = text.length;
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing --- line first: a missing close beats any line error.
  const fmLines = [];
  let pos = nl === -1 ? len : nl + 1;
  let lineIdx = 0; // 0-based index of the line starting at pos
  let closeIdx = -1;
  let bodyStart = len;
  while (pos < len) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    lineIdx++;
    if (line === '---') {
      closeIdx = lineIdx;
      bodyStart = end === -1 ? len : end + 1;
      break;
    }
    fmLines.push(line);
    if (end === -1) break;
    pos = end + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 2} is not "key: value"` };
    const key = line.slice(0, ci);
    let keyOk = true;
    for (let j = 0; j < key.length; j++) {
      const c = key[j];
      if (!((c >= 'a' && c <= 'z') || c === '_')) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${i + 2} is not "key: value"` };
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line[ci + 1] === ' ') raw = line.slice(ci + 2);
    else return { error: `line ${i + 2} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    if (KNOWN_KEYS[key] !== 1) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function findUnesc(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline into `out`; `link(target)` resolves a link target.
 *  Plain runs are skipped with one native regex scan for the next special
 *  character (lastIndex is reset before every exec, so the recursion below
 *  cannot disturb it), and flushed through one bulk escape. */
const SP_RE = /[\\`*\[]/g;

function inlineInto(s, link, out) {
  const n = s.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    SP_RE.lastIndex = i;
    const m = SP_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (plain < j) out.push(esc(s.slice(plain, j)));
        out.push(s[j + 1]);
        i = j + 2;
        plain = i;
      } else i = j + 1; // a lone backslash stays plain text
      continue;
    }
    if (c === '`') {
      const mm = s.indexOf('`', j + 1);
      if (mm > j + 1) {
        if (plain < j) out.push(esc(s.slice(plain, j)));
        out.push('<code>', esc(s.slice(j + 1, mm)), '</code>');
        i = mm + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const mm = findUnesc(s, '**', j + 2);
        if (mm > j + 2) {
          if (plain < j) out.push(esc(s.slice(plain, j)));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, mm), link, out);
          out.push('</strong>');
          i = mm + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const mm = findSingleStar(s, j + 1);
      if (mm > j + 1) {
        if (plain < j) out.push(esc(s.slice(plain, j)));
        out.push('<em>');
        inlineInto(s.slice(j + 1, mm), link, out);
        out.push('</em>');
        i = mm + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // c === '['
    const kk = findUnesc(s, ']', j + 1);
    if (kk !== -1 && s[kk + 1] === '(') {
      const mm = s.indexOf(')', kk + 2);
      const target = mm === -1 ? '' : s.slice(kk + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (plain < j) out.push(esc(s.slice(plain, j)));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(j + 1, kk), link, out);
        out.push('</a>');
        i = mm + 1;
        plain = i;
        continue;
      }
    }
    i = j + 1;
  }
  if (plain < n) out.push(esc(s.slice(plain)));
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** Fence-open language, or null. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return null;
  }
  return line.slice(3, j);
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** Heading {depth, text} or null. */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (line[k] !== ' ' && line[k] !== '\t') return null;
  let a = k;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (a === b) return null;
  return { depth: k, text: line.slice(a, b) };
}

function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let k = 3; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: cheap first-char dispatch, full check
 *  only for lines that could match (blank, fence, heading, break). */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return isBlankLine(line);
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHR(line);
  return false;
}

/** Bullet capture after "- " / "* ", or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** Ordered [start, capture] or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
  if (j === 0 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return [Number(line.slice(0, j)), line.slice(j + 2)];
}

function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k < 2) return false;
  if (k >= line.length) return false;
  const c = line[k];
  return c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\v' && c !== '\f';
}

/** Rendered HTML, toc and excerpt for one body, written straight into the
 *  page's output array (one join per page, no per-block strings). */
function renderMarkdown(src, link, out) {
  const lines = src.split('\n');
  const n = lines.length;
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.length === 0 ? '' : line[0];
    if (c0 === '' || c0 === ' ' || c0 === '\t') {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // Indented, non-blank: falls through to the paragraph below.
    } else if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        out.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>`);
        while (i < n && !fenceClose(lines[i])) {
          out.push(esc(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>', '\n');
        continue;
      }
    } else if (c0 === '#') {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugOfText(h.text), ids);
        out.push(`<h${h.depth} id="${id}">`);
        const start = out.length;
        inlineInto(h.text, link, out);
        const html = out.slice(start).join('');
        out.push(`</h${h.depth}>`, '\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(line)) {
        out.push('<hr>', '\n');
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.slice(1);
        if (l[0] === ' ') l = l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const bcap = (c0 === '-' || c0 === '*') ? bulletOf(line) : null;
    const ocap = bcap === null && c0 >= '0' && c0 <= '9' ? orderedOf(line) : null;
    if (bcap !== null || ocap !== null) {
      const isOrdered = ocap !== null;
      const items = [];
      while (i < n) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? ocap[0] : 1;
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inlineInto(items[k].join('\n'), link, out);
        out.push('</li>', '\n');
      }
      out.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    out.push('<p>');
    const start = out.length;
    inlineInto(body.join('\n'), link, out);
    if (excerpt === null) excerpt = out.slice(start).join('');
    out.push('</p>', '\n');
  }
  return { toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds, as compact arrays:
// [0, text] text | [1, path, raw] var/raw | [2, path, not, then, else|null] if
// [3, name, path, body] for | [4, name] include
//
// Tokenising and parsing happen in one pass (no intermediate token objects):
// the scanner below is the template dialect's tokeniser, and each token is
// acted on at once. A {% %} tag alone on its line takes the whole line.
function parseTemplate(name, src) {
  const rootBody = [];
  const stack = [{ kind: 'root', node: null, body: rootBody }];
  let cur = stack[0];
  const pushText = (text) => {
    if (text !== '') cur.body.push([0, text]);
  };
  const pushTag = (tag) => {
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [3, m[1], pathOf(name, m[2]), []];
      cur.body.push(node);
      const frame = { kind: 'for', node, body: node[3] };
      stack.push(frame);
      cur = frame;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [2, pathOf(name, m[2]), m[1] !== undefined, [], null];
      cur.body.push(node);
      const frame = { kind: 'if', node, body: node[3] };
      stack.push(frame);
      cur = frame;
    } else if (tag === 'else') {
      if (cur.kind !== 'if' || cur.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      cur.node[4] = [];
      cur.body = cur.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (cur.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      cur = stack[stack.length - 1];
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) cur.body.push([4, m[1]]);
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  };
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText(text);
      text = '';
      cur.body.push([1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()), raw]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let before = src.slice(lineStart, open);
    let after = src.slice(end, lineEnd);
    let standalone = true;
    for (let k = 0; k < before.length; k++) {
      if (before[k] !== ' ' && before[k] !== '\t') { standalone = false; break; }
    }
    if (standalone) {
      for (let k = 0; k < after.length; k++) {
        if (after[k] !== ' ' && after[k] !== '\t') { standalone = false; break; }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText(text);
    text = '';
    pushTag(src.slice(open + 2, close).trim());
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText(text);
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return rootBody;
}

/** Value at `path` in the scope chain (frames, innermost last). */
function lookup(frames, path) {
  let v;
  let f = frames.length - 1;
  for (; f >= 0; f--) {
    const o = frames[f];
    if (Object.hasOwn(o, path[0])) {
      v = o[path[0]];
      break;
    }
  }
  if (f < 0) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, frames, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1: {
        const t = textOf(lookup(frames, n[1]));
        out.push(n[2] ? t : esc(t));
        break;
      }
      case 2: {
        const v = truthy(lookup(frames, n[1]));
        const branch = v !== n[2] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, frames, templates, depth, out);
        break;
      }
      case 3: {
        const xs = lookup(frames, n[2]);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const fr = {};
          fr[n[1]] = xs[k];
          fr.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          frames.push(fr);
          renderNodes(n[3], frames, templates, depth, out);
          frames.pop();
        }
        break;
      }
      case 4: {
        if (depth < 8) {
          const t = templates.get(n[1]);
          if (t !== undefined) renderNodes(t, frames, templates, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** Words: runs of characters other than whitespace (JS \s, exactly). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  const tnames = Object.keys(input.templates).sort(cmp);
  for (let i = 0; i < tnames.length; i++) {
    const name = tnames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  while (base.length > 0 && base[base.length - 1] === '/') base = base.slice(0, -1);

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 0; d < RESERVED.length; d++) {
      const dir = RESERVED[d];
      if (dir !== 'posts' && s.path.startsWith(`${dir}/`)) { own = dir; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugOfText(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const out = [];
    const md = renderMarkdown(s.body, link, out);
    s.html = out.join('');
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const names = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const slug = slugOfText(names[i]);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(names[i]);
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugOfText(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugOfText(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()];
  tags.sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Cards, pages and layouts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const merged = { site, tags: allTags, recent };
    const keys = Object.keys(vars);
    for (let i = 0; i < keys.length; i++) merged[keys[i]] = vars[keys[i]];
    const out = [];
    renderNodes(nodes, [merged], templates, 0, out);
    return out.join('');
  };

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    // Posts already have their card (built above); pages build theirs here.
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(cmp);
  let pagesCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pagesCount++;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
