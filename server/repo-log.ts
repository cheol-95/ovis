import type { RepoBranch, RepoBranches, RepoCommitDetail, RepoCommitSummary, RepoLog, RepoPerson } from "../shared/protocol.ts";
import { errorResponse, jsonResponse } from "./http.ts";
import { EMPTY_BASE, OID, REPO_DIFF_DEADLINE_MS, REPO_DIFF_MAX_LIST_BYTES, RepoDiffError, checkRevision, repositoryOf, resolveRevision, runGit, type GitContext, type GitRun } from "./repo-diff.ts";

/**
 * A repository's history, read with git and never written: a page of commits, the local branches
 * with how far each is from its upstream, and one commit's message with the base its changes are
 * read against through the diff routes (server/repo-diff.ts). They are built like those routes:
 * every git call is an argv array run by the same runner (no shell, no pager, no optional locks,
 * no fsmonitor hook, literal pathspecs), with a byte cap on what is read and a deadline after which
 * the process is killed, and every refusal is in the API's own words, never git's stderr. Nothing
 * here fetches, so an upstream's ahead/behind is as of the last fetch.
 */

export const REPO_LOG_DEFAULT_LIMIT = 50;
export const REPO_LOG_MAX_LIMIT = 100;
/** At most this many branches; `truncated` says when there were more. */
export const REPO_BRANCHES_MAX = 200;
/** One commit's message; a longer one is cut on a character boundary and marked `message_truncated`. */
export const REPO_SHOW_MAX_MESSAGE_BYTES = 64 * 1024;
/** Room for a commit's hashes, names, addresses and dates ahead of its message. */
const SHOW_HEADER_BYTES = 64 * 1024;

export interface RepoLogOptions {
  /** the git to run (a stand-in, in tests) */
  git?: string;
  deadlineMs?: number;
  /** what one listing command (the log page, the refs, the branches) may print */
  maxListBytes?: number;
  maxBranches?: number;
}

interface Context extends GitContext { maxListBytes: number; maxBranches: number }

function contextOf(options: RepoLogOptions): Context {
  return {
    git: options.git ?? "git",
    deadlineMs: options.deadlineMs ?? REPO_DIFF_DEADLINE_MS,
    maxListBytes: options.maxListBytes ?? REPO_DIFF_MAX_LIST_BYTES,
    maxBranches: options.maxBranches ?? REPO_BRANCHES_MAX,
  };
}

/**
 * The commit fields every read asks for, NUL-separated, the free text last: a cap that cuts the
 * output then cuts the text, never a hash or a date. Messages are re-encoded to UTF-8 whatever
 * the repository's `i18n.logOutputEncoding`, and a signature is never printed into the record.
 */
const PEOPLE = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI"];
const LOG_ARGS = ["-c", "i18n.logOutputEncoding=UTF-8", "log", "--no-color", "--no-show-signature", "-z"];

/** The integer in `value`, or null when it is not one in `min`..`max` written in plain digits. */
function integer(value: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

/** `text` cut to at most `maxBytes` of UTF-8 without splitting a character. */
function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

/** A capped read ends wherever the cap fell, mid-character too: the half character is not text. */
const trimCut = (text: string): string => text.replace(/\uFFFD+$/u, "");

interface Records { records: string[][]; partial: string[] | null }

/** NUL-terminated records of `width` fields each; with `overflow`, the record the cap cut into, its fields so far. */
function recordsOf(run: GitRun, width: number): Records {
  const fields = run.stdout.split("\0");
  // what follows the last NUL is a record's tail the cap cut, or nothing
  const tail = fields.pop() ?? "";
  const records: string[][] = [];
  for (let index = 0; index + width <= fields.length; index += width) records.push(fields.slice(index, index + width));
  if (!run.overflow) return { records, partial: null };
  return { records, partial: [...fields.slice(records.length * width), trimCut(tail)] };
}

function people(fields: string[]): Pick<RepoCommitSummary, "oid" | "parents" | "author" | "committer"> {
  const [oid, parents, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = fields as [string, string, string, string, string, string, string, string];
  const person = (name: string, email: string, date: string): RepoPerson => ({ name, email, date });
  return {
    oid,
    parents: parents === "" ? [] : parents.split(" "),
    author: person(authorName, authorEmail, authorDate),
    committer: person(committerName, committerEmail, committerDate),
  };
}

/**
 * Every branch and tag by the commit it is at, by full refname, so a name with a comma, a slash or
 * a space reads as itself (`%d` decorations join names with `, `). A remote's symbolic HEAD names
 * no branch of its own and is left out.
 */
async function refsByCommit(context: Context, root: string): Promise<{ refs: Map<string, string[]>; truncated: boolean }> {
  const run = await runGit(context, root, ["for-each-ref", "--sort=refname", "--format=%(objectname)%00%(*objectname)%00%(symref)%00%(refname)", "--", "refs/heads/", "refs/remotes/", "refs/tags/"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository's refs", 500);
  const refs = new Map<string, string[]>();
  // one ref per line (a refname holds no control character); what follows the last newline was cut short
  for (const line of run.stdout.split("\n").slice(0, -1)) {
    const [oid, peeled, symref, name] = line.split("\0");
    if (oid === undefined || peeled === undefined || symref === undefined || name === undefined || symref !== "") continue;
    // an annotated tag is shown at the commit it points at
    const at = peeled === "" ? oid : peeled;
    refs.set(at, [...(refs.get(at) ?? []), name]);
  }
  return { refs, truncated: run.overflow };
}

/** GET /api/workspace/git/log */
export async function repoLog(cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<RepoLog> {
  const context = contextOf(options);
  const limitParam = params.get("limit");
  const limit = limitParam === null || limitParam === "" ? REPO_LOG_DEFAULT_LIMIT : integer(limitParam, 1, REPO_LOG_MAX_LIMIT);
  if (limit === null) throw new RepoDiffError("invalid_limit", `limit must be a whole number from 1 to ${REPO_LOG_MAX_LIMIT}`, 400);
  const skipParam = params.get("skip");
  const skip = skipParam === null || skipParam === "" ? 0 : integer(skipParam, 0, 999_999_999);
  if (skip === null) throw new RepoDiffError("invalid_skip", "skip must be a whole number of commits, 0 or more", 400);
  const refParam = params.get("ref");
  const ref = refParam === null || refParam === "" ? "HEAD" : refParam;
  const pinned = params.get("oid");
  if (pinned !== null && pinned !== "" && !OID.test(pinned)) throw new RepoDiffError("invalid_oid", "oid must be the full commit hash a first page answered with", 400);

  const repository = await repositoryOf(context, cwd);
  const root = repository.root;
  await checkRevision(context, root, "ref", ref);
  const answer = (oid: string | null, commits: RepoCommitSummary[], nextSkip: number | null, refsTruncated: boolean): RepoLog => ({
    repository, ref, oid, commits, skip, limit, next_skip: nextSkip, refs_truncated: refsTruncated,
    limits: { max_limit: REPO_LOG_MAX_LIMIT, max_list_bytes: context.maxListBytes },
  });
  let start: string;
  if (pinned !== null && pinned !== "") {
    // the pin is a commit of this repository, not a tag object's id or a stranger's hash
    if (await resolveRevision(context, root, "oid", pinned) !== pinned) throw new RepoDiffError("revision_not_found", "oid names no commit in this repository", 404);
    start = pinned;
  } else if (ref === "HEAD" && repository.unborn) {
    // no commit yet: an empty history, not a missing one
    return answer(null, [], null, false);
  } else {
    start = await resolveRevision(context, root, "ref", ref);
  }

  // one commit past the page says whether there is a next one
  const [run, refs] = await Promise.all([
    runGit(context, root, [...LOG_ARGS, `--format=${[...PEOPLE, "%s"].join("%x00")}`, `--skip=${skip}`, `--max-count=${limit + 1}`, start, "--"], context.maxListBytes),
    refsByCommit(context, root),
  ]);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read this repository's history", 500);
  const { records, partial } = recordsOf(run, PEOPLE.length + 1);
  const commits: RepoCommitSummary[] = records.slice(0, limit).map((fields) => ({ ...people(fields), subject: fields[PEOPLE.length]!, subject_truncated: false, refs: refs.refs.get(fields[0]!) ?? [] }));
  // the cap fell inside a subject: that commit ends the page with what of it was read
  if (partial !== null && partial.length === PEOPLE.length + 1 && commits.length < limit) {
    commits.push({ ...people(partial), subject: partial[PEOPLE.length]!, subject_truncated: true, refs: refs.refs.get(partial[0]!) ?? [] });
  }
  if (commits.length === 0 && run.overflow) throw new RepoDiffError("too_large", "a commit here is too large to list", 500);
  const more = run.overflow || records.length > limit;
  return answer(start, commits, more ? skip + commits.length : null, refs.truncated);
}

/** `ahead 2, behind 1`, `ahead 2`, `behind 1`, `gone` or nothing (in step), as `%(upstream:track,nobracket)` prints them. */
function tracking(upstream: string, track: string): Pick<RepoBranch, "upstream" | "ahead" | "behind" | "gone"> {
  if (upstream === "") return { upstream: null, ahead: null, behind: null, gone: false };
  if (track === "gone") return { upstream, ahead: null, behind: null, gone: true };
  const count = (word: string): number => Number(new RegExp(`\\b${word} (\\d+)`).exec(track)?.[1] ?? 0);
  return { upstream, ahead: count("ahead"), behind: count("behind"), gone: false };
}

/**
 * GET /api/workspace/git/branches: the local branches, the one checked out here first and then by
 * last commit, newest first, each with its upstream and how far it is from it. Read from the refs
 * on disk; nothing is fetched.
 */
export async function repoBranches(cwd: string, options: RepoLogOptions = {}): Promise<RepoBranches> {
  const context = contextOf(options);
  const repository = await repositoryOf(context, cwd);
  // the last --sort is the first key: newest commit first, then by name
  const run = await runGit(context, repository.root, ["for-each-ref", "--sort=refname", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(HEAD)%00%(upstream)%00%(upstream:track,nobracket)", "--", "refs/heads/"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository's branches", 500);
  const branches: RepoBranch[] = [];
  // one branch per line, its fields NUL-separated; what follows the last newline was cut short
  for (const line of run.stdout.split("\n").slice(0, -1)) {
    const [refname, oid, date, head, upstream, track] = line.split("\0");
    if (refname === undefined || oid === undefined || date === undefined || head === undefined || upstream === undefined || track === undefined || !refname.startsWith("refs/heads/") || !OID.test(oid)) continue;
    const branch: RepoBranch = { name: refname.slice("refs/heads/".length), refname, oid, date, current: head === "*", ...tracking(upstream, track) };
    if (branch.current) branches.unshift(branch);
    else branches.push(branch);
  }
  return {
    repository,
    branches: branches.slice(0, context.maxBranches),
    truncated: run.overflow || branches.length > context.maxBranches,
    limits: { max_branches: context.maxBranches, max_list_bytes: context.maxListBytes },
  };
}

/** GET /api/workspace/git/show: one commit's whole message, its people, and the base its changes are read against. */
export async function repoShow(cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<RepoCommitDetail> {
  const context = contextOf(options);
  const rev = params.get("rev");
  if (rev === null || rev === "") throw new RepoDiffError("missing_revision", "rev must name the commit to show", 400);
  const repository = await repositoryOf(context, cwd);
  const oid = await resolveRevision(context, repository.root, "rev", rev);
  const run = await runGit(context, repository.root, [...LOG_ARGS, "--max-count=1", "--no-walk", `--format=${[...PEOPLE, "%B"].join("%x00")}`, oid, "--"], SHOW_HEADER_BYTES + REPO_SHOW_MAX_MESSAGE_BYTES);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read that commit", 500);
  const { records, partial } = recordsOf(run, PEOPLE.length + 1);
  const fields = records[0] ?? (partial !== null && partial.length === PEOPLE.length + 1 ? partial : null);
  if (fields === null || fields[0] !== oid) throw new RepoDiffError("too_large", "that commit is too large to show", 500);
  const message = cutUtf8(fields[PEOPLE.length]!, REPO_SHOW_MAX_MESSAGE_BYTES);
  const commit = { ...people(fields), message: message.text, message_truncated: message.cut || records.length === 0 };
  return { repository, commit, base: commit.parents[0] ?? EMPTY_BASE, limits: { max_message_bytes: REPO_SHOW_MAX_MESSAGE_BYTES } };
}

/** The HTTP answer of any of the three routes, with every refusal in the `{ error: { code, message } }` envelope. */
export async function repoLogResponse(kind: "log" | "branches" | "show", cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<Response> {
  try {
    const body = kind === "log" ? await repoLog(cwd, params, options) : kind === "branches" ? await repoBranches(cwd, options) : await repoShow(cwd, params, options);
    return jsonResponse(body, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof RepoDiffError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
