// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats — unified diff,
// SEARCH/REPLACE blocks, V4A and JSON tool calls — finds the lines each edit names at the first of three matching
// tiers (exact, trailing-whitespace, whitespace-trimmed), and changes every file or none, printing one line per
// changed path (A, D, M, or R for a move) or one error line per failed edit. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that applied, in order, as [old path, new path]: the output loop turns a qualifying pair into R. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  fin: boolean;
}

function toModel(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { br, lines: parts, fin };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

/** One body line of a unified hunk or a V4A chunk: context, old-only, new-only, or a `\` marker line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'add' | 'bs';
  text: string;
  /** True when the patch line itself was empty (an empty context line): trailing ones end no hunk body. */
  emptyLine?: boolean;
}

/** A piece of the new text of a match: a context line (by its index in O) or an added line. */
type NPart = { ctx: number } | { add: string };

function bodyToOP(body: BodyLine[]): { o: string[]; parts: NPart[] } {
  const o: string[] = [];
  const parts: NPart[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      parts.push({ ctx: o.length });
      o.push(b.text);
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'add') parts.push({ add: b.text });
  }
  return { o, parts };
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6's end-of-file rule). */
function bsAfterLastCtxAdd(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === 'ctx' || k === 'add') return i + 1 < body.length && body[i + 1]!.kind === 'bs';
  }
  return false;
}

/** Whether a `\` line follows the body's last `+` line (the created-file rule of section 6). */
function bsAfterLastAdd(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === 'add') return i + 1 < body.length && body[i + 1]!.kind === 'bs';
  }
  return false;
}

// Section 5: matching lines at three tiers.

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function normAt(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position at which O occurs in `lines` under one tier's comparison; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normAt(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normAt(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  at: number[];
}

/** O's occurrences at the first tier that has one, or null when no tier does. */
function findMatch(lines: string[], o: string[], strict: boolean): Match | null {
  for (const t of tierList(strict)) {
    const at = occurrences(lines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/**
 * The lines a match writes: context pieces are the file's own matched lines; at tier 2 every other piece is
 * re-indented, the file's first matched line's leading whitespace replacing O's first line's in each piece that
 * is not blank and starts with it.
 */
function buildN(o: string[], parts: NPart[], fileLines: string[], pos: number, tier: number): string[] {
  let lead: { f: string; p: string } | null = null;
  if (tier === 2 && o.length > 0) {
    lead = { f: /^[ \t]*/.exec(fileLines[pos]!)![0]!, p: /^[ \t]*/.exec(o[0]!)![0]! };
  }
  return parts.map((part) => {
    if ('ctx' in part) return fileLines[pos + part.ctx]!;
    const s = part.add;
    if (lead === null || /^[ \t]*$/.test(s)) return s;
    return s.startsWith(lead.p) ? lead.f + s.slice(lead.p.length) : s;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// Section 6: unified diffs.

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null;
  plus: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** A header path (section 6): up to the first tab, surrounding spaces removed, one leading a/ or b/ removed. */
function headerPath(rest: string): string {
  let p = rest.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply one section's hunks, in order, to a file model; a hunk that finds nothing fails the section. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, parts } = bodyToOP(h.body);
    if (o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
      const added = buildN(o, parts, model.lines, pos, 0);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...added);
      if (atEnd) model.fin = !bsAfterLastCtxAdd(h.body);
      d += added.length;
      continue;
    }
    const m = findMatch(model.lines, o, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = m.at[0]!;
    for (const p of m.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const written = buildN(o, parts, model.lines, pos, m.tier);
    const reachesEnd = pos + o.length === model.lines.length;
    model.lines.splice(pos, o.length, ...written);
    if (reachesEnd) model.fin = !bsAfterLastCtxAdd(h.body);
    d += written.length - o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.minus ?? s.renFrom ?? s.gitOld;
  const newP = s.plus ?? s.renTo ?? s.gitNew;
  return (tree) => {
    for (const p of [oldP, newP]) {
      if (p !== null && p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (oldP === '/dev/null' || s.newFile) {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        let hasAdd = false;
        for (const b of h.body) {
          if (b.kind === 'add') {
            out.push(b.text);
            hasAdd = true;
          }
        }
        if (hasAdd) fin = !bsAfterLastAdd(h.body);
      }
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (newP === '/dev/null' || s.delFile) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const model = toModel(before);
    applyHunks(model, s.hunks, strict, from);
    if (to !== from) {
      tree.now.set(to, fromModel(model));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, fromModel(model));
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, minus: null, plus: null, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) newSection();
      cur!.minus = headerPath(line.slice(4));
      cur!.plus = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') body.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (c === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (c === '-') body.push({ kind: 'old', text: bl.slice(1) });
        else if (c === '+') body.push({ kind: 'add', text: bl.slice(1) });
        else if (c === '\\') body.push({ kind: 'bs', text: bl });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine === true) body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('+++ ')) cur.plus = headerPath(line.slice(4));
      else if (line.startsWith('rename from ')) cur.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = toModel(before);
    const m = findMatch(model.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.at.length > 1) throw new Fail('ambiguous', path);
    const pos = m.at[0]!;
    const written = buildN(oldLines, newLines.map((s) => ({ add: s })), model.lines, pos, m.tier);
    model.lines.splice(pos, oldLines.length, ...written);
    tree.now.set(path, fromModel(model));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    let path: string | null = null;
    for (let j = i - 1; j >= scanFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VRaw {
  kind: 'add' | 'del' | 'upd';
  path: string;
  no: number;
  content: { no: number; text: string }[];
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tierList(strict)) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (normAt(model.lines[k]!, t) === normAt(ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, parts } = bodyToOP(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const written = buildN(o, parts, model.lines, pos, 0);
        model.lines.splice(pos, 0, ...written);
        cursor = pos + written.length;
        continue;
      }
      let pos = -1;
      let tierUsed = 0;
      for (const t of tierList(strict)) {
        const occ = occurrences(model.lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === model.lines.length));
        if (occ.length > 0) {
          pos = occ[0]!;
          tierUsed = t;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', path);
      const written = buildN(o, parts, model.lines, pos, tierUsed);
      model.lines.splice(pos, o.length, ...written);
      cursor = pos + written.length;
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, fromModel(model));
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, fromModel(model));
    }
  };
}

/**
 * The chunks of one V4A Update File section (section 8): an optional `*** Move to:` first line, then chunks that
 * start at `@@` lines — the first may instead start at a body line — with `*** End of File` closing a chunk and
 * anchoring it to the file's end. A line that is none of those cannot be read: a parse error at its line.
 */
function v4aChunks(raw: VRaw): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let start = 0;
  if (raw.content.length > 0 && raw.content[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw.content[0]!.text.slice('*** Move to:'.length).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  for (let k = start; k < raw.content.length; k += 1) {
    const c = raw.content[k]!;
    if (c.text.startsWith('@@')) {
      if (chunk !== null) chunks.push(chunk);
      const anchorText = c.text.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      continue;
    }
    if (c.text.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${c.no}`);
      chunk.eof = true;
      chunks.push(chunk);
      chunk = null;
      continue;
    }
    const ch0 = c.text[0];
    if (c.text === '' || ch0 === ' ' || ch0 === '-' || ch0 === '+') {
      if (chunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.no}`);
        chunk = { anchor: null, eof: false, body: [] };
      }
      chunk.body.push(
        c.text === '' ? { kind: 'ctx', text: '' } : ch0 === ' ' ? { kind: 'ctx', text: c.text.slice(1) } : ch0 === '-' ? { kind: 'old', text: c.text.slice(1) } : { kind: 'add', text: c.text.slice(1) },
      );
      continue;
    }
    throw new Exit2(`error: parse ${c.no}`);
  }
  if (chunk !== null) chunks.push(chunk);
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const raws: VRaw[] = [];
  let cur: VRaw | null = null;
  const sectionStart = (line: string): { kind: VRaw['kind']; path: string } | null => {
    for (const [pre, kind] of [['*** Add File:', 'add'], ['*** Delete File:', 'del'], ['*** Update File:', 'upd']] as const) {
      if (line.startsWith(pre)) return { kind, path: line.slice(pre.length).trim() };
    }
    return null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const st = sectionStart(line);
    if (st !== null) {
      cur = { kind: st.kind, path: st.path, no: i + 1, content: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.content.push({ no: i + 1, text: line });
  }
  const edits: Edit[] = [];
  for (const raw of raws) {
    while (raw.content.length > 0 && raw.content[raw.content.length - 1]!.text.trim() === '') raw.content.pop();
    if (raw.kind === 'add') {
      const fileLines: string[] = [];
      for (const c of raw.content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      const path = raw.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (raw.kind === 'del') {
      if (raw.content.length > 0) throw new Exit2(`error: parse ${raw.content[0]!.no}`);
      const path = raw.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    const { moveTo, chunks } = v4aChunks(raw);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.no}`);
    edits.push(v4aUpdate(raw.path, moveTo, chunks, strict));
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // A move pair becomes one R line when the old path is gone and the new one appeared (SPEC.md section 2).
  const rNew = new Map<string, string>();
  const rOld = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (rOld.has(o) || rNew.has(n)) continue;
    if (tree.original(o) === null || tree.original(n) !== null) continue;
    if (tree.get(o) !== null || tree.get(n) === null) continue;
    rOld.add(o);
    rNew.set(n, o);
  }
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    rows.push({ key: p, text: `${was === null ? 'A' : tree.now.get(p) === null ? 'D' : 'M'} ${p}` });
  }
  for (const [n, o] of rNew) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((x, y) => byBytes(x.key, y.key));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
