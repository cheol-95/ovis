### Added
- Three read-only API routes for a pane's repository history, beside the diff routes:
  `GET /api/workspace/git/log` (a page of commits with the refs on each, pinned by the first
  page's commit), `GET /api/workspace/git/branches` (local branches with upstream, ahead/behind
  and a gone upstream) and `GET /api/workspace/git/show` (one commit's message, people and the
  base to read its changes from; `base=empty` reads a root commit's changes through the diff
  routes). The same paths under `/api/machines/<id>/` reach a remote PC. Like the diff routes they
  are closed to watching devices and to other sites' pages.
