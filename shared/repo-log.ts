import type { RepoDiffRepository } from "./repo-diff.ts";

/** Who wrote or committed a commit, as git recorded it (no mailmap), with the date in strict ISO 8601 and its own offset. */
export interface RepoPerson {
  name: string;
  email: string;
  date: string;
}

/** One commit of a log page. */
export interface RepoCommitSummary {
  /** full hash */
  oid: string;
  /** full hashes, first parent first; empty for a root commit */
  parents: string[];
  author: RepoPerson;
  committer: RepoPerson;
  /** the message's first paragraph on one line, as `git log --format=%s` prints it */
  subject: string;
  /** the page's byte cap cut `subject` short */
  subject_truncated: boolean;
  /** full refnames at this commit (`refs/heads/…`, `refs/remotes/…`, `refs/tags/…`, a tag by the commit it points at), sorted; a remote's symbolic HEAD left out */
  refs: string[];
}

/** GET /api/workspace/git/log */
export interface RepoLog {
  repository: RepoDiffRepository;
  /** the ref the page was asked from, `HEAD` when none was named */
  ref: string;
  /** the commit the walk starts from: pass it as `oid` for the later pages; null in a repository with no commit yet */
  oid: string | null;
  /** newest first, at most `limit` */
  commits: RepoCommitSummary[];
  skip: number;
  limit: number;
  /** `skip` for the next page; null on the last one */
  next_skip: number | null;
  /** the refs were cut at the byte cap, so a commit may carry fewer than it has */
  refs_truncated: boolean;
  limits: { max_limit: number; max_list_bytes: number };
}

/** One local branch. */
export interface RepoBranch {
  /** the branch's name, `refs/heads/` left off: `feature/x` */
  name: string;
  /** its full refname */
  refname: string;
  /** the commit it is at */
  oid: string;
  /** that commit's committer date, strict ISO 8601 */
  date: string;
  /** checked out in this working tree */
  current: boolean;
  /** the full refname of its upstream (`refs/remotes/origin/main`, or `refs/heads/…` for a local one); null when none is set */
  upstream: string | null;
  /** commits on the branch and not on its upstream, and the other way; null with no upstream or a gone one */
  ahead: number | null;
  behind: number | null;
  /** an upstream is set and that ref no longer exists */
  gone: boolean;
}

/** GET /api/workspace/git/branches */
export interface RepoBranches {
  repository: RepoDiffRepository;
  /** the current branch first, then by last commit, newest first */
  branches: RepoBranch[];
  /** `branches` is not the whole list */
  truncated: boolean;
  limits: { max_branches: number; max_list_bytes: number };
}

/** GET /api/workspace/git/show */
export interface RepoCommitDetail {
  repository: RepoDiffRepository;
  commit: {
    oid: string;
    parents: string[];
    author: RepoPerson;
    committer: RepoPerson;
    /** the whole raw message, up to `limits.max_message_bytes`, cut on a character boundary */
    message: string;
    message_truncated: boolean;
  };
  /**
   * What the commit's changes are read against with the diff routes (`scope=commit&base=…&head=<oid>`):
   * its first parent, or `empty` for a root commit.
   */
  base: string;
  limits: { max_message_bytes: number };
}
