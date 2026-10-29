# Kiro CLI sessions

Recorded on Linux on 2026-10-29 for #1350 with Kiro CLI 2.35.1 on its default V2 engine, in a
throwaway `HOME` and throwaway project folders. No account was signed in: `KIRO_API_KEY` held a
dummy value and the model's replies came from Kiro's own test hook `KIRO_MOCK_CHAT_RESPONSE`, a
JSON file of replies (`[[<text> | {tool_use_id, name, args}]...]`, one inner array per model
request). Every record, key and key order is as Kiro wrote it, and the tools really ran. Only the
paths were replaced: the throwaway home with `/home/user`, and the project folders with
`/home/user/demo`, `/home/user/project` and `/home/user/scratch`.

Kiro V2 keeps each session in `~/.kiro/sessions/cli/` (`$KIRO_HOME/sessions/cli/` when
`KIRO_HOME` is set) as `<id>.jsonl`, one `{version: "v1", kind, data}` record per line, beside a
`<id>.json` record of its folder, times and title, and a `<id>.history` of typed prompts.

- `tools-resumed-2.35.1.jsonl` / `.json`: `kiro-cli chat --no-interactive`, one prompt that
  `read`s `README.md` (a `text` result), then `kiro-cli chat --resume` with a second prompt that
  runs `shell` `ls -1` (a `json` result with `exit_status`, `stdout` and `stderr`) and a `read` of
  a missing file (`status: "error"`, `results.<id>.result.Error.Custom`, `tool: null`). The
  resume appended to the same file.
- `interactive-2.35.1.jsonl` / `.json`: the interactive TUI, one prompt and its answer.
- `chat-new-2.35.1.jsonl` / `.json`: the session `/chat new` opened in that TUI (written empty),
  then one prompt and answer.
- `lock-2.35.1.json`: the `<id>.lock` Kiro keeps beside the session its process has open:
  `{"pid": <the kiro-cli-chat acp process>, "started_at": <when that session was opened>}`.
  It is written when a session opens (the first prompt in the TUI), moves to the new session on
  `/chat new` and to the loaded one on `/chat <id>`, and is deleted on `/quit`.

Not recorded: reasoning (`thinking`, which the mock cannot produce), and the `Compaction`,
`ResetTo`, `CancelledPrompt` and `Clear` records that Kiro 2.35.1's `LogEntryV1` also defines.
Kiro's V3 engine (`kiro-cli --v3`, or `chat.agentEngine: "v3"`) keeps its sessions elsewhere
(`~/.kiro/sessions/<folder hash>/sess_<id>/`) and is not covered here.
