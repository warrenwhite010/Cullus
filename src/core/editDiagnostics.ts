// Turning "could not find exact match" into something a model can act on.
//
// The failure this exists for, measured: `edit_file` reported
// "Could not find exact match" and nothing else — no diff, no near-miss, no
// bytes. The model then spent NINETEEN consecutive steps on `awk`, `sed`,
// `od -c`, `xxd` and six python heredocs trying to see what was actually in the
// file, misread `od -c`'s space-separated byte output as literal spaces in the
// source, concluded the file was corrupt, and burnt the whole turn. Not one pair
// of those calls was identical, so the repetition guard never fired.
//
// Every one of those steps was the model doing the enricher's job by hand. The
// information it needed — what the file actually contains where it expected its
// search string — is one read away from the process that reported the failure.
//
// The tool itself belongs to @modelcontextprotocol/server-filesystem, so this
// cannot live in the tool. It runs after dispatch, on the way back.

import * as fs from "fs";
import * as path from "path";

/** Error text that means "I looked for your string and did not find it". */
const NO_MATCH = /not\s+found|no\s+match|exact\s+match|could\s+not\s+locate|does\s+not\s+appear/i;

/** Biggest file worth scanning. Beyond this the fuzzy pass is not worth the wall time. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Longest search string we will try to locate. */
const MAX_NEEDLE_CHARS = 20_000;

export interface EditEvidence {
  /** The file as it actually is, at the place the search came closest. */
  file: string;
  searchedFor: string;
  /** Exact-match count. 0 = absent, >1 = present but ambiguous. */
  occurrences: number;
  /** Why the match failed, in one line, when it can be named precisely. */
  likelyCause?: string;
  /** The closest region of the file, verbatim, with line numbers. */
  closestRegion?: string;
  /** Line-by-line comparison of the search against that region. */
  diff?: string;
  actionRequired: string;
}

/** Normalise the things that make two visually identical strings differ. */
function normalise(text: string, opts: { ws?: boolean; eol?: boolean; tabs?: boolean; quotes?: boolean } = {}): string {
  let out = text;
  // Splitting a CRLF file on "\n" leaves a trailing "\r" on every line, so the
  // pairwise comparison below has to drop those too, not just the \r\n digraph.
  if (opts.eol) out = out.replace(/\r\n/g, "\n").replace(/\r$/gm, "");
  if (opts.tabs) out = out.replace(/\t/g, "    ");
  if (opts.quotes) out = out.replace(/[‘’‛]/g, "'").replace(/[“”‟]/g, '"');
  if (opts.ws) out = out.replace(/[ \t ]+/g, " ").replace(/[ \t]+$/gm, "").trim();
  return out;
}

/**
 * Name the difference, when one normalisation explains the whole failure.
 *
 * Ordered most-specific first: a string that differs only in line endings is a
 * more useful thing to be told than one that "differs in whitespace", even
 * though both are true.
 */
function nameCause(needle: string, region: string): string | undefined {
  if (normalise(needle, { eol: true }) === normalise(region, { eol: true })) {
    return "Line endings differ — the file uses CRLF where your search used LF, or the reverse. The text is otherwise identical.";
  }
  if (normalise(needle, { tabs: true, eol: true }) === normalise(region, { tabs: true, eol: true })) {
    return "Indentation differs — tabs versus spaces. The text is otherwise identical.";
  }
  if (normalise(needle, { quotes: true, eol: true }) === normalise(region, { quotes: true, eol: true })) {
    return "Quote characters differ — one side uses typographic quotes (‘ ’ “ ”), the other ASCII. The text is otherwise identical.";
  }
  if (/[ \t]+$/m.test(needle) && !/[ \t]+$/m.test(region)) {
    return "Your search string has trailing whitespace at the end of a line; the file does not.";
  }
  if (!/[ \t]+$/m.test(needle) && /[ \t]+$/m.test(region)) {
    return "The file has trailing whitespace at the end of a line; your search string does not.";
  }
  if (/ /.test(region) && !/ /.test(needle)) {
    return "The file contains a non-breaking space (U+00A0) where your search used a normal space.";
  }
  if (normalise(needle, { ws: true, eol: true }) === normalise(region, { ws: true, eol: true })) {
    return "Only whitespace differs — the amount of indentation or spacing inside a line. The words are identical.";
  }
  return undefined;
}

/** The window of file lines that best matches the search, by normalised equality. */
function closestWindow(
  fileLines: string[],
  needleLines: string[]
): { start: number; score: number } | null {
  if (needleLines.length === 0 || fileLines.length === 0) return null;

  const SCORING = { ws: true, eol: true, tabs: true, quotes: true } as const;
  const wanted = needleLines.map((l) => normalise(l, SCORING));
  const span = Math.min(needleLines.length, fileLines.length);

  let best: { start: number; score: number } | null = null;

  for (let start = 0; start + span <= fileLines.length; start++) {
    let score = 0;
    for (let i = 0; i < span; i++) {
      const have = normalise(fileLines[start + i], SCORING);
      if (have === wanted[i]) score += 2;
      else if (have && wanted[i] && (have.includes(wanted[i]) || wanted[i].includes(have))) score += 1;
    }
    if (!best || score > best.score) best = { start, score };
  }

  // A window that matched nothing is not a near-miss; saying "here is the
  // closest region" about an arbitrary slice of the file would be worse than
  // saying nothing.
  return best && best.score > 0 ? best : null;
}

function withLineNumbers(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(firstLine + i).padStart(width)} | ${line}`)
    .join("\n");
}

/** A compact line-by-line comparison. `-` is what you asked for, `+` what is there. */
function renderDiff(needleLines: string[], regionLines: string[]): string {
  const rows: string[] = [];
  const span = Math.max(needleLines.length, regionLines.length);

  for (let i = 0; i < span; i++) {
    const want = needleLines[i];
    const have = regionLines[i];

    if (want === have) {
      rows.push(`  ${want ?? ""}`);
      continue;
    }
    if (want !== undefined) rows.push(`- ${JSON.stringify(want)}`);
    if (have !== undefined) rows.push(`+ ${JSON.stringify(have)}`);
  }

  // JSON.stringify on the differing lines is deliberate: it makes trailing
  // spaces, tabs and CR visible, which is the entire point. `od -c` was the
  // model's own attempt at this and it misread the result.
  return rows.join("\n");
}

/** Every search string this call was trying to find. */
function needlesFrom(args: any): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && v.length <= MAX_NEEDLE_CHARS) out.push(v);
  };

  // @modelcontextprotocol/server-filesystem: edits: [{ oldText, newText }]
  if (Array.isArray(args?.edits)) {
    for (const edit of args.edits) push(edit?.oldText ?? edit?.old_text ?? edit?.old_string);
  }
  push(args?.oldText);
  push(args?.old_string);
  push(args?.search);
  push(args?.find);

  return out;
}

function pathFrom(args: any): string | null {
  const candidate = ["path", "file", "filepath", "filePath", "target"]
    .map((key) => args?.[key])
    .find((v) => typeof v === "string" && v.length > 0);
  return typeof candidate === "string" ? candidate : null;
}

/**
 * Evidence for a failed edit, or null when this is not that kind of failure.
 *
 * Never throws: this runs on the return path of a tool call that has already
 * failed, and turning a bad error into an exception would lose the original.
 */
export function explainEditFailure(
  toolName: string,
  args: unknown,
  result: unknown
): EditEvidence | null {
  try {
    if (!/edit|patch|replace|write/i.test(toolName)) return null;

    const error = result as any;
    const text =
      typeof error === "string"
        ? error
        : `${error?.message ?? ""} ${error?.error ?? ""} ${error?.content ?? ""}`;
    if (!NO_MATCH.test(String(text))) return null;

    const target = pathFrom(args);
    const needles = needlesFrom(args);
    if (!target || needles.length === 0) return null;

    const resolved = path.resolve(target);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;

    const content = fs.readFileSync(resolved, "utf-8");
    const fileLines = content.split("\n");

    // The first needle that is genuinely absent is the one that failed. A needle
    // present exactly once is not the problem, so skip past it.
    for (const needle of needles) {
      const occurrences = content.split(needle).length - 1;
      if (occurrences === 1) continue;

      if (occurrences > 1) {
        return {
          file: resolved,
          searchedFor: needle.slice(0, 400),
          occurrences,
          likelyCause:
            `That string appears ${occurrences} times in the file, so the edit is ambiguous ` +
            `rather than impossible.`,
          actionRequired:
            "Extend the search string with surrounding lines until it is unique, then retry. " +
            "Do not read the file through the shell to work this out — you already have the " +
            "information you need.",
        };
      }

      const needleLines = needle.split("\n");
      const window = closestWindow(fileLines, needleLines);

      if (!window) {
        return {
          file: resolved,
          searchedFor: needle.slice(0, 400),
          occurrences: 0,
          likelyCause:
            "Nothing in the file resembles that string. It may belong to a different file, or " +
            "the change may already have been applied.",
          actionRequired:
            `Read ${path.basename(resolved)} and confirm what is actually there before editing ` +
            "again. Do not retry this call unchanged, and do not inspect the file with `od`, " +
            "`xxd` or `sed` — the file reader gives you the same bytes without the guesswork.",
        };
      }

      const regionLines = fileLines.slice(window.start, window.start + needleLines.length);
      const region = regionLines.join("\n");

      return {
        file: resolved,
        searchedFor: needle.slice(0, 400),
        occurrences: 0,
        likelyCause:
          nameCause(needle, region) ??
          "The closest region of the file differs from your search string in the content below.",
        closestRegion: withLineNumbers(regionLines, window.start + 1),
        diff: renderDiff(needleLines, regionLines),
        actionRequired:
          `Copy the '+' lines above VERBATIM as your search string and retry. They are the ` +
          `file's actual bytes at line ${window.start + 1}; quoted strings show whitespace, ` +
          `tabs and carriage returns exactly. Do not inspect the file with \`od\`, \`xxd\`, ` +
          `\`awk\` or \`sed\` — that information is already here.`,
      };
    }

    return null;
  } catch {
    // An unreadable file, a bad path, a race with another writer: the original
    // error still reaches the model, just without the extra evidence.
    return null;
  }
}
