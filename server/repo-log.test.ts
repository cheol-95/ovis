import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError, RepoBranches, RepoCommitDetail, RepoDiffFileList, RepoDiffFilePatch, RepoLog } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { REPO_BRANCHES_MAX, REPO_LOG_DEFAULT_LIMIT, REPO_LOG_MAX_LIMIT, REPO_SHOW_MAX_MESSAGE_BYTES, repoBranches, repoLog, repoShow } from "./repo-log.ts";

/**
 * Real git repositories in a temp folder, as for the diff routes: what the routes answer is what
 * git prints, so a stand-in git would prove nothing. The developer's own git configuration is kept
 * out, for the fixtures and for the code under test alike.
 */
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-log-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * git in `cwd`, with commits dated `date` (seconds since the epoch) when given, so their order is the
 * fixture's. The offset is not UTC: git 2.4x prints UTC as `Z` where older ones print `+00:00`.
 */
function git(cwd: string, args: string[], date?: number): string {
  const stamp = date === undefined ? {} : { GIT_AUTHOR_DATE: `${date} +0900`, GIT_COMMITTER_DATE: `${date} +0900` };
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...stamp } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const T0 = 1_800_000_000;

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  return root;
}

/** One commit changing `file`, at T0 + `minute` minutes; its full hash. */
function commit(root: string, minute: number, message: string, file = "a.txt"): string {
  writeFileSync(join(root, file), `${message.slice(0, 64)}\n`);
  git(root, ["add", "."]);
  // from a file: a long message passes the size one argument may have
  const messageFile = join(scratch, "message.txt");
  writeFileSync(messageFile, message);
  git(root, ["commit", "-q", "--allow-empty-message", "--cleanup=verbatim", "-F", messageFile], T0 + minute * 60);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

const query = (values: Record<string, string> = {}) => new URLSearchParams(values);

async function refusal(promise: Promise<unknown>): Promise<[string, number]> {
  try {
    await promise;
  } catch (error) {
    const { code, status } = error as { code: string; status: number };
    return [code, status];
  }
  throw new Error("expected a refusal");
}

describe("repoLog", () => {
  let root: string;
  const oids: string[] = [];
  beforeAll(() => {
    root = repository("log");
    for (let index = 1; index <= 5; index += 1) oids.push(commit(root, index, `commit ${index}`));
    // a branch whose name holds a comma and a slash, an annotated tag, a remote branch and its symbolic HEAD
    git(root, ["branch", "feat/x,y", oids[2]!]);
    git(root, ["tag", "-a", "v1", "-m", "release", oids[1]!]);
    git(root, ["update-ref", "refs/remotes/origin/main", oids[3]!]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  });

  it("lists commits newest first from HEAD, each with its parents, people, subject and the refs on it", async () => {
    const page = await repoLog(root, query());
    expect(page).toMatchObject({ ref: "HEAD", oid: oids[4], skip: 0, limit: REPO_LOG_DEFAULT_LIMIT, next_skip: null, limits: { max_limit: REPO_LOG_MAX_LIMIT } });
    expect(page.repository).toMatchObject({ root, branch: "main", head: oids[4] });
    expect(page.commits.map((entry) => entry.subject)).toEqual(["commit 5", "commit 4", "commit 3", "commit 2", "commit 1"]);
    expect(page.commits.map((entry) => entry.oid)).toEqual([...oids].reverse());
    expect(page.commits[0]).toEqual({
      oid: oids[4]!,
      parents: [oids[3]!],
      author: { name: "Fixture", email: "fixture@example.invalid", date: "2027-01-15T17:05:00+09:00" },
      committer: { name: "Fixture", email: "fixture@example.invalid", date: "2027-01-15T17:05:00+09:00" },
      subject: "commit 5",
      subject_truncated: false,
      refs: ["refs/heads/main"],
    });
    expect(page.commits[4]!.parents).toEqual([]);
    expect(page.commits.map((entry) => entry.refs)).toEqual([["refs/heads/main"], ["refs/remotes/origin/main"], ["refs/heads/feat/x,y"], ["refs/tags/v1"], []]);
  });

  it("pages from the first page's commit, so a commit made in between does not shift the later pages", async () => {
    const first = await repoLog(root, query({ limit: "2" }));
    expect(first.commits.map((entry) => entry.subject)).toEqual(["commit 5", "commit 4"]);
    expect(first.next_skip).toBe(2);
    const later = commit(root, 6, "commit 6");
    try {
      const second = await repoLog(root, query({ limit: "2", skip: "2", oid: first.oid! }));
      expect(second).toMatchObject({ oid: first.oid, skip: 2, next_skip: 4 });
      expect(second.commits.map((entry) => entry.subject)).toEqual(["commit 3", "commit 2"]);
      const last = await repoLog(root, query({ limit: "2", skip: "4", oid: first.oid! }));
      expect(last.commits.map((entry) => entry.subject)).toEqual(["commit 1"]);
      expect(last.next_skip).toBeNull();
      // without the pin, HEAD moved on and the page starts from the new commit
      expect((await repoLog(root, query({ limit: "1" }))).commits.map((entry) => entry.oid)).toEqual([later]);
      expect((await repoLog(root, query({ skip: "99" }))).commits).toEqual([]);
    } finally {
      git(root, ["reset", "-q", "--hard", oids[4]!]);
    }
  });

  it("reads from a named ref, a full branch name with a comma included", async () => {
    const branch = await repoLog(root, query({ ref: "refs/heads/feat/x,y" }));
    expect(branch).toMatchObject({ ref: "refs/heads/feat/x,y", oid: oids[2] });
    expect(branch.commits.map((entry) => entry.subject)).toEqual(["commit 3", "commit 2", "commit 1"]);
    // a tag object is read as the commit it points at
    expect((await repoLog(root, query({ ref: "v1", limit: "1" }))).commits.map((entry) => entry.oid)).toEqual([oids[1]!]);
    expect((await repoLog(root, query({ ref: "HEAD~3" }))).oid).toBe(oids[1]!);
  });

  it("refuses a malformed or unknown ref, oid, limit or skip in its own words", async () => {
    for (const [values, code, status] of [
      [{ limit: "0" }, "invalid_limit", 400],
      [{ limit: String(REPO_LOG_MAX_LIMIT + 1) }, "invalid_limit", 400],
      [{ limit: "1e2" }, "invalid_limit", 400],
      [{ skip: "-1" }, "invalid_skip", 400],
      [{ skip: "1.5" }, "invalid_skip", 400],
      [{ ref: "--output=/tmp/x" }, "invalid_revision", 400],
      [{ ref: "main..HEAD" }, "invalid_revision", 400],
      [{ ref: "nope" }, "revision_not_found", 404],
      [{ oid: "HEAD" }, "invalid_oid", 400],
      [{ oid: "a".repeat(41) }, "invalid_oid", 400],
      [{ oid: "0".repeat(40) }, "revision_not_found", 404],
    ] as const) {
      expect([values, ...(await refusal(repoLog(root, query(values))))]).toEqual([values, code, status]);
    }
  });

  it("answers an empty page for a repository with no commit yet, and refuses a folder outside any", async () => {
    const unborn = repository("log-unborn");
    expect(await repoLog(unborn, query())).toMatchObject({ oid: null, commits: [], next_skip: null, repository: { unborn: true } });
    const outside = join(scratch, "not-a-repository");
    mkdirSync(outside);
    expect(await refusal(repoLog(outside, query()))).toEqual(["not_a_repository", 409]);
  });

  it("cuts a page at the byte cap between whole commits, and a subject too long for it short of the cap", async () => {
    const big = repository("log-big");
    commit(big, 1, "small");
    commit(big, 2, `huge ${"x".repeat(8_000)}`);
    commit(big, 3, "after");
    const page = await repoLog(big, query(), { maxListBytes: 1_024 });
    // the first commit fits, the second's subject is cut to what is left, and the page ends there
    expect(page.commits.map((entry) => [entry.subject.slice(0, 5), entry.subject_truncated])).toEqual([["after", false], ["huge ", true]]);
    expect(Buffer.byteLength(page.commits[1]!.subject)).toBeLessThan(1_024);
    expect(page.next_skip).toBe(2);
    const rest = await repoLog(big, query({ skip: "2", oid: page.oid! }), { maxListBytes: 1_024 });
    expect(rest.commits.map((entry) => entry.subject)).toEqual(["small"]);
    expect(rest.next_skip).toBeNull();
  });
});

describe("repoBranches", () => {
  it("lists local branches, the current one first and then by last commit, with upstream, ahead/behind and gone", async () => {
    const root = repository("branches");
    const first = commit(root, 1, "one");
    commit(root, 2, "two");
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", first]);
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "branch.main.merge", "refs/heads/main"]);
    // an older branch whose upstream was deleted, and a newer one following main locally and behind it
    git(root, ["checkout", "-q", "-b", "gone/one", first]);
    git(root, ["config", "branch.gone/one.remote", "origin"]);
    git(root, ["config", "branch.gone/one.merge", "refs/heads/deleted"]);
    git(root, ["checkout", "-q", "-b", "feat/x,y", first]);
    commit(root, 3, "three", "b.txt");
    git(root, ["checkout", "-q", "-b", "follower", first]);
    git(root, ["config", "branch.follower.remote", "."]);
    git(root, ["config", "branch.follower.merge", "refs/heads/main"]);
    git(root, ["checkout", "-q", "main"]);

    const listed = await repoBranches(root);
    expect(listed).toMatchObject({ truncated: false, limits: { max_branches: REPO_BRANCHES_MAX } });
    expect(listed.branches.map((branch) => [branch.name, branch.current, branch.upstream, branch.ahead, branch.behind, branch.gone])).toEqual([
      ["main", true, "refs/remotes/origin/main", 1, 0, false],
      ["feat/x,y", false, null, null, null, false],
      ["follower", false, "refs/heads/main", 0, 1, false],
      ["gone/one", false, "refs/remotes/origin/deleted", null, null, true],
    ]);
    expect(listed.branches[0]).toMatchObject({ refname: "refs/heads/main", oid: git(root, ["rev-parse", "main"]).trim(), date: "2027-01-15T17:02:00+09:00" });

    // the cap keeps the current branch, and says the list was cut
    const capped = await repoBranches(root, { maxBranches: 2 });
    expect(capped.branches.map((branch) => branch.name)).toEqual(["main", "feat/x,y"]);
    expect(capped.truncated).toBe(true);

    // on a detached HEAD no branch is current
    git(root, ["checkout", "-q", "--detach", first]);
    expect((await repoBranches(root)).branches.some((branch) => branch.current)).toBe(false);
  });
});

describe("repoShow", () => {
  let root: string;
  let rootCommit: string;
  let second: string;
  beforeAll(() => {
    root = repository("show");
    rootCommit = commit(root, 1, "root subject\n\nroot body\nsecond line");
    second = commit(root, 2, "second", "b.txt");
  });

  it("answers one commit's whole message, its people, and its first parent as the base to diff from", async () => {
    const shown = await repoShow(root, query({ rev: "HEAD" }));
    expect(shown).toMatchObject({ base: rootCommit, limits: { max_message_bytes: REPO_SHOW_MAX_MESSAGE_BYTES } });
    expect(shown.commit).toEqual({
      oid: second,
      parents: [rootCommit],
      author: { name: "Fixture", email: "fixture@example.invalid", date: "2027-01-15T17:02:00+09:00" },
      committer: { name: "Fixture", email: "fixture@example.invalid", date: "2027-01-15T17:02:00+09:00" },
      message: "second",
      message_truncated: false,
    });
    const first = await repoShow(root, query({ rev: rootCommit }));
    expect(first.commit.message).toBe("root subject\n\nroot body\nsecond line");
    expect(first.commit.parents).toEqual([]);
    expect(first.base).toBe("empty");
  });

  it("gives a merge its first parent as the base", async () => {
    const merged = repository("show-merge");
    const base = commit(merged, 1, "base");
    git(merged, ["checkout", "-q", "-b", "side"]);
    const side = commit(merged, 2, "side", "side.txt");
    git(merged, ["checkout", "-q", "main"]);
    const main = commit(merged, 3, "main", "main.txt");
    git(merged, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], T0 + 4 * 60);
    const shown = await repoShow(merged, query({ rev: "HEAD" }));
    expect(shown.commit.parents).toEqual([main, side]);
    expect(shown.base).toBe(main);
    expect(base).not.toBe(main);
  });

  it("cuts a message past the cap on a character boundary and says so", async () => {
    const long = repository("show-long");
    commit(long, 1, `subject\n\n${"한".repeat(REPO_SHOW_MAX_MESSAGE_BYTES)}`);
    const shown = await repoShow(long, query({ rev: "HEAD" }));
    expect(shown.commit.message_truncated).toBe(true);
    expect(Buffer.byteLength(shown.commit.message)).toBeLessThanOrEqual(REPO_SHOW_MAX_MESSAGE_BYTES);
    expect(shown.commit.message).toStartWith("subject\n\n한");
    expect(shown.commit.message).not.toContain("\uFFFD");
  });

  it("refuses a missing, malformed or unknown rev", async () => {
    for (const [values, code, status] of [
      [{}, "missing_revision", 400],
      [{ rev: "--all" }, "invalid_revision", 400],
      [{ rev: "nope" }, "revision_not_found", 404],
    ] as const) {
      expect([values, ...(await refusal(repoShow(root, query(values))))]).toEqual([values, code, status]);
    }
  });
});

describe("GET /api/workspace/git/*", () => {
  let root: string;
  let rootCommit: string;
  let head: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-repo-log-state-"));
  const owner = { authorization: "Bearer test-repo-log" };
  beforeAll(() => {
    root = repository("http");
    rootCommit = commit(root, 1, "first");
    head = commit(root, 2, "second", "b.txt");
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    // a first pairing is a device only once its cookie came back: that return is what saves it
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `ovis_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-repo-log", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  const directory = () => `directory=${encodeURIComponent(root)}`;
  const get = (path: string, headers: Record<string, string> = owner) => fetch(`${base}/api/${path}`, { headers });

  it("answers the log, the branches and one commit for a named folder, never cached", async () => {
    const log = await get(`workspace/git/log?${directory()}&limit=1`);
    expect(log.status).toBe(200);
    expect(log.headers.get("cache-control")).toBe("private, no-store");
    const page = await log.json() as RepoLog;
    expect(page.commits.map((entry) => entry.oid)).toEqual([head]);
    expect(page.next_skip).toBe(1);

    const branches = await get(`workspace/git/branches?${directory()}`);
    expect(branches.status).toBe(200);
    expect(branches.headers.get("cache-control")).toBe("private, no-store");
    expect((await branches.json() as RepoBranches).branches.map((branch) => [branch.name, branch.current])).toEqual([["main", true]]);

    const show = await get(`workspace/git/show?${directory()}&rev=${rootCommit}`);
    expect(show.status).toBe(200);
    expect(show.headers.get("cache-control")).toBe("private, no-store");
    const shown = await show.json() as RepoCommitDetail;
    expect(shown).toMatchObject({ base: "empty", commit: { oid: rootCommit, message: "first" } });
  });

  it("reads a root commit's changes through the diff routes from the base it answered", async () => {
    const listed = await get(`workspace/diff/files?${directory()}&scope=commit&base=empty&head=${rootCommit}`);
    expect(listed.status).toBe(200);
    const list = await listed.json() as RepoDiffFileList;
    expect(list).toMatchObject({ scope: "commit", base: "empty", head: rootCommit });
    expect(list.files).toEqual([{ path: "a.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }]);
    const patched = await get(`workspace/diff/file?${directory()}&scope=commit&base=empty&head=${rootCommit}&path=a.txt`);
    expect(patched.status).toBe(200);
    const patch = await patched.json() as RepoDiffFilePatch;
    expect(patch.patch).toStartWith("diff --git a/a.txt b/a.txt\nnew file mode 100644\n");
    expect(patch.patch).toEndWith("+first\n");
    // `empty` is the base only: a head that names it is refused as before
    const refused = await get(`workspace/diff/files?${directory()}&scope=commit&base=${rootCommit}&head=empty`);
    expect(refused.status).toBe(404);
    expect((await refused.json() as ApiError).error.code).toBe("revision_not_found");
  });

  it("refuses bad input in the error envelope", async () => {
    for (const [path, status, code] of [
      ["workspace/git/log", 400, "missing_directory"],
      ["workspace/git/log?directory=relative%2Ffolder", 400, "invalid_cwd"],
      [`workspace/git/log?directory=${encodeURIComponent(scratch)}`, 409, "not_a_repository"],
      [`workspace/git/log?${directory()}&limit=500`, 400, "invalid_limit"],
      [`workspace/git/log?${directory()}&ref=nope`, 404, "revision_not_found"],
      [`workspace/git/show?${directory()}`, 400, "missing_revision"],
      [`workspace/git/show?${directory()}&rev=--output%3D%2Ftmp%2Fx`, 400, "invalid_revision"],
      // only the three reads are routes
      [`workspace/git/blame?${directory()}`, 404, "not_found"],
    ] as const) {
      const response = await get(path);
      expect([path, response.status]).toEqual([path, status]);
      const body = await response.json() as ApiError;
      expect([path, body.error.code]).toEqual([path, code]);
      expect(typeof body.error.message).toBe("string");
    }
    const posted = await fetch(`${base}/api/workspace/git/log?${directory()}`, { method: "POST", headers: { ...owner, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect((await posted.json() as ApiError).error.code).toBe("method_not_allowed");
  });

  it("is closed to a stranger, to another site's page and to a device that can only watch", async () => {
    for (const route of ["log", "branches", "show"]) {
      expect((await get(`workspace/git/${route}?${directory()}&rev=HEAD`, {})).status).toBe(401);
      const crossSite = await get(`workspace/git/${route}?${directory()}&rev=HEAD`, { ...owner, "sec-fetch-site": "cross-site" });
      expect([route, crossSite.status]).toEqual([route, 403]);
      expect((await crossSite.json() as ApiError).error.code).toBe("cross_site");
    }
    expect((await get("session", { cookie: watchCookie })).status).not.toBe(401);
    for (const path of ["workspace/git/log", "workspace/git/branches", "workspace/git/show", "machines/pc1/workspace/git/log", "machines/pc1/workspace/git/branches", "machines/pc1/workspace/git/show", "machines/local/workspace/git/show"]) {
      const response = await get(`${path}?${directory()}&rev=HEAD`, { cookie: watchCookie });
      expect([path, response.status]).toEqual([path, 403]);
      expect((await response.json() as ApiError).error.code).toBe("read_only");
    }
  });
});
