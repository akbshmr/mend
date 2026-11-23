// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its own line break, and whether its text ends with that break. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, br, finalBreak };
}

function joinFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.finalBreak ? fs.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
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

// ---- Matching lines (SPEC.md section 5) ----

const rstripST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripST(a) === rstripST(b);
  return trimST(a) === trimST(b);
}

/** Every position at or after `from` where O's lines match the file's lines at `tier`; occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier with an occurrence at or after `from` (and, for an end-of-file chunk, ending at the last line). */
function findTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eof: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let ps = occurrences(fileLines, o, t, from);
    if (eof) ps = ps.filter((p) => p + o.length === fileLines.length);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

type BodyKind = 'ctx' | 'minus' | 'plus';
interface BodyLine {
  kind: BodyKind;
  text: string;
  noNL: boolean;
}

/**
 * The lines that replace the matched region: context lines are the file's own matched lines; at tier 2 the other
 * lines of N are re-indented from O's first line's indentation P to the file's first matched line's F.
 */
function buildSegment(fileLines: string[], pos: number, entries: BodyLine[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadST(fileLines[pos] ?? '');
    const firstOld = entries.find((e) => e.kind !== 'plus');
    p = firstOld === undefined ? '' : leadST(firstOld.text);
  }
  let mi = 0;
  for (const e of entries) {
    if (e.kind === 'minus') {
      mi += 1;
    } else if (e.kind === 'ctx') {
      out.push(fileLines[pos + mi]!);
      mi += 1;
    } else {
      let t = e.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
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

// ---- Unified diffs (SPEC.md section 6) ----

const DEVNULL = '\u0000/dev/null';

interface Hunk {
  a: number;
  entries: BodyLine[];
  hasCtxPlus: boolean;
  lastCtxPlusNoNL: boolean;
}

interface Section {
  startLine: number;
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return DEVNULL;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** The paths of a `diff --git a/<X> b/<Y>` line, or null when the line is not of that form. */
function gitPaths(line: string): { x: string; y: string } | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const body = rest.slice(2);
  const at = body.indexOf(' b/');
  if (at < 0) return null;
  return { x: body.slice(0, at), y: body.slice(at + 3) };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s|$)/;

function makeHunk(a: number, raw: string[]): Hunk {
  const entries: BodyLine[] = [];
  for (const bl of raw) {
    if (bl === '') entries.push({ kind: 'ctx', text: '', noNL: false });
    else if (bl[0] === '\\') {
      const prev = entries[entries.length - 1];
      if (prev !== undefined) prev.noNL = true;
    } else if (bl[0] === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), noNL: false });
    else if (bl[0] === '-') entries.push({ kind: 'minus', text: bl.slice(1), noNL: false });
    else entries.push({ kind: 'plus', text: bl.slice(1), noNL: false });
  }
  let hasCtxPlus = false;
  let lastCtxPlusNoNL = false;
  for (const e of entries) {
    if (e.kind !== 'minus') {
      hasCtxPlus = true;
      lastCtxPlusNoNL = e.noNL;
    }
  }
  return { a, entries, hasCtxPlus, lastCtxPlusNoNL };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const isPairStart = (k: number): boolean => lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');

  const scanHeader = (sec: Section, from: number): number => {
    let k = from;
    while (k < lines.length) {
      const line = lines[k]!;
      if (line.startsWith('@@') || line.startsWith('diff --git ')) break;
      if (line.startsWith('--- ')) {
        if ((lines[k + 1] ?? '').startsWith('+++ ')) {
          if (sec.hasPair) break;
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(lines[k + 1]!);
          sec.hasPair = true;
          k += 2;
          continue;
        }
        throw new Exit2(`error: parse ${k + 2}`);
      }
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.isNew = true;
      else if (line.startsWith('deleted file mode')) sec.isDel = true;
      k += 1;
    }
    return k;
  };

  const scanHunks = (sec: Section, from: number): number => {
    let k = from;
    if (sec.isDel || sec.pairNew === DEVNULL) {
      // A deletion's hunks are not read: skip to the next section.
      while (k < lines.length && !lines[k]!.startsWith('diff --git ') && !isPairStart(k)) k += 1;
      return k;
    }
    while (k < lines.length) {
      const line = lines[k]!;
      if (line.startsWith('diff --git ') || isPairStart(k)) break;
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${k + 1}`);
        const a = parseInt(m[1]!, 10);
        k += 1;
        const raw: string[] = [];
        while (k < lines.length) {
          const bl = lines[k]!;
          if (bl.startsWith('diff --git ') || isPairStart(k)) break;
          if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
            raw.push(bl);
            k += 1;
            continue;
          }
          break;
        }
        while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
        sec.hunks.push(makeHunk(a, raw));
        continue;
      }
      k += 1;
    }
    return k;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    let sec: Section | null = null;
    if (line.startsWith('diff --git ')) {
      const g = gitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = {
        startLine: i + 1, gitOld: g.x, gitNew: g.y, pairOld: null, pairNew: null,
        renameOld: null, renameNew: null, isNew: false, isDel: false, hasPair: false, hunks: [],
      };
      i += 1;
    } else if (isPairStart(i)) {
      sec = {
        startLine: i + 1, gitOld: null, gitNew: null, pairOld: null, pairNew: null,
        renameOld: null, renameNew: null, isNew: false, isDel: false, hasPair: false, hunks: [],
      };
    }
    if (sec === null) {
      i += 1;
      continue;
    }
    i = scanHeader(sec, i);
    i = scanHunks(sec, i);
    sections.push(sec);
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld ?? sec.renameOld ?? sec.gitOld;
    const newPath = sec.pairNew ?? sec.renameNew ?? sec.gitNew;
    const isCreate = sec.isNew || oldPath === DEVNULL;
    const isDelete = sec.isDel || newPath === DEVNULL;
    if (isCreate) {
      const p = newPath;
      if (p === null || p === DEVNULL) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      let lastPlus: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'plus') {
            plusLines.push(e.text);
            lastPlus = e;
          }
        }
      }
      const fs: FileState = { lines: plusLines, br: '\n', finalBreak: !(lastPlus !== null && lastPlus.noNL) };
      tree.now.set(p, joinFile(fs));
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null || p === DEVNULL) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldPath;
    const dst = newPath;
    if (src === null || dst === null) throw new Exit2(`error: parse ${sec.startLine}`);
    if (!safe(src)) throw new Fail('unsafe', src);
    if (dst !== src && !safe(dst)) throw new Fail('unsafe', dst);
    const content = tree.get(src);
    if (content === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const fs = splitFile(content);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(fs, h, d, strict, src);
      let oLen = 0;
      let nLen = 0;
      for (const e of h.entries) {
        if (e.kind !== 'plus') oLen += 1;
        if (e.kind !== 'minus') nLen += 1;
      }
      d += nLen - oLen;
    }
    if (dst !== src) {
      tree.now.set(dst, joinFile(fs));
      tree.now.set(src, null);
      tree.moves.push({ from: src, to: dst });
    } else {
      tree.now.set(src, joinFile(fs));
    }
  };
}

function applyHunk(fs: FileState, h: Hunk, d: number, strict: boolean, path: string): void {
  const o: string[] = [];
  for (const e of h.entries) if (e.kind !== 'plus') o.push(e.text);
  if (o.length === 0) {
    const seg = buildSegment(fs.lines, 0, h.entries, 0);
    const at = Math.min(h.a + d, fs.lines.length);
    const atEnd = at === fs.lines.length;
    fs.lines.splice(at, 0, ...seg);
    if (atEnd && seg.length > 0) fs.finalBreak = !h.lastCtxPlusNoNL;
    return;
  }
  const found = findTier(fs.lines, o, strict, 0, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const seg = buildSegment(fs.lines, pos, h.entries, found.tier);
  const runsToEnd = pos + o.length === fs.lines.length;
  fs.lines.splice(pos, o.length, ...seg);
  if (runsToEnd) fs.finalBreak = h.hasCtxPlus ? !h.lastCtxPlusNoNL : true;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= searchFrom; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const fs: FileState = { lines: [...newLines], br: '\n', finalBreak: true };
        tree.now.set(p, joinFile(fs));
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const fs = splitFile(content);
      const found = findTier(fs.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const entries: BodyLine[] = [
        ...oldLines.map((t) => ({ kind: 'minus' as BodyKind, text: t, noNL: false })),
        ...newLines.map((t) => ({ kind: 'plus' as BodyKind, text: t, noNL: false })),
      ];
      const seg = buildSegment(fs.lines, pos, entries, found.tier);
      fs.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, joinFile(fs));
    });
    prevPath = path;
    i = rep + 1;
    searchFrom = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

const ADD_PRE = '*** Add File: ';
const DEL_PRE = '*** Delete File: ';
const UPD_PRE = '*** Update File: ';
const MOVE_PRE = '*** Move to: ';

interface Chunk {
  anchor: string | null;
  entries: BodyLine[];
  eof: boolean;
}

function parseChunks(block: string[], base: number): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = 0;
  const lineNo = (k: number): number => base + k + 1;
  while (pos < block.length) {
    let anchor: string | null = null;
    if (block[pos]!.startsWith('@@')) {
      const t = block[pos]!.slice(2).trim();
      anchor = t === '' ? null : t;
      pos += 1;
    } else if (chunks.length > 0) {
      throw new Exit2(`error: parse ${lineNo(pos)}`);
    }
    const entries: BodyLine[] = [];
    let eof = false;
    while (pos < block.length) {
      const bl = block[pos]!;
      if (bl === '*** End of File') {
        eof = true;
        pos += 1;
        break;
      }
      if (bl.startsWith('@@')) break;
      if (bl === '') entries.push({ kind: 'ctx', text: '', noNL: false });
      else if (bl[0] === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), noNL: false });
      else if (bl[0] === '-') entries.push({ kind: 'minus', text: bl.slice(1), noNL: false });
      else if (bl[0] === '+') entries.push({ kind: 'plus', text: bl.slice(1), noNL: false });
      else break;
      pos += 1;
    }
    if (entries.length === 0 && !eof && anchor === null) throw new Exit2(`error: parse ${lineNo(pos)}`);
    chunks.push({ anchor, entries, eof });
  }
  return chunks;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastNB = k;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith(ADD_PRE) || l.startsWith(DEL_PRE) || l.startsWith(UPD_PRE);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD_PRE)) {
      const p = line.slice(ADD_PRE.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < lastNB && (lines[i]!.startsWith('+') || lines[i] === '')) {
        fileLines.push(lines[i] === '' ? '' : lines[i]!.slice(1));
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (line.startsWith(DEL_PRE)) {
      const p = line.slice(DEL_PRE.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (line.startsWith(UPD_PRE)) {
      const headerLine = i + 1;
      const p = line.slice(UPD_PRE.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < lastNB && lines[i]!.startsWith(MOVE_PRE)) {
        moveTo = lines[i]!.slice(MOVE_PRE.length).trim();
        i += 1;
      }
      const blockStart = i;
      let j = i;
      while (j < lastNB && !isSectionStart(lines[j]!)) j += 1;
      const block = lines.slice(blockStart, j);
      i = j;
      let bend = block.length;
      while (bend > 0 && block[bend - 1]!.trim() === '') bend -= 1;
      const chunks = parseChunks(block.slice(0, bend), blockStart);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const mt = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const fs = splitFile(content);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const anchor = ch.anchor;
            let foundAt = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              for (let k = cursor; k < fs.lines.length; k += 1) {
                if (lineEq(fs.lines[k]!, anchor, t)) {
                  foundAt = k;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          const o: string[] = [];
          for (const e of ch.entries) if (e.kind !== 'plus') o.push(e.text);
          if (o.length === 0) {
            const seg = buildSegment(fs.lines, cursor, ch.entries, 0);
            const at = ch.eof ? fs.lines.length : Math.min(cursor, fs.lines.length);
            fs.lines.splice(at, 0, ...seg);
            cursor = at + seg.length;
            continue;
          }
          const found = findTier(fs.lines, o, strict, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          const seg = buildSegment(fs.lines, pos, ch.entries, found.tier);
          fs.lines.splice(pos, o.length, ...seg);
          cursor = pos + seg.length;
        }
        if (mt !== null) {
          tree.now.set(mt, joinFile(fs));
          tree.now.set(p, null);
          tree.moves.push({ from: p, to: mt });
        } else {
          tree.now.set(p, joinFile(fs));
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- JSON edits (SPEC.md section 9) ----

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

// ---- Invocation, output and the all-or-nothing write (SPEC.md sections 1, 2 and 10) ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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
  const changed = new Map<string, string | null>();
  for (const [p, v] of tree.now) {
    if (tree.original(p) !== v) changed.set(p, v);
  }
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (usedFrom.has(mv.from) || usedTo.has(mv.to)) continue;
    const wasFrom = tree.original(mv.from);
    const nowFrom = tree.now.get(mv.from);
    const wasTo = tree.original(mv.to);
    const nowTo = tree.now.get(mv.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null && nowTo !== undefined) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      usedFrom.add(mv.from);
      usedTo.add(mv.to);
    }
  }
  for (const p of changed.keys()) {
    if (usedFrom.has(p) || usedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const [p, v] of changed) {
      if (v === null) rmSync(p, { force: true });
    }
    for (const [p, v] of changed) {
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
