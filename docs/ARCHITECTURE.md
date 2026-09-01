# Design document / architecture (svn-mcp)

> Read this document before modifying the code of this project.
> It summarizes the overall structure, design philosophy, how to extend it, and pitfalls.
> Per-tool argument specifications are in [TOOLS.md](TOOLS.md); user-facing setup is in [../README.md](../README.md).

---

## 1. What this is

A server that exposes the **read-only commands** of an SVN repository (log / list / cat / diff / info) as MCP (Model Context Protocol) tools. It lets AI agents (GitHub Copilot CLI, Claude Code, etc.) read commit history, file contents, and diffs from SVN.

- Language: TypeScript (ESM, Node.js 22+)
- Dependencies: only `@modelcontextprotocol/sdk` and `zod`
- svn execution: `spawn` from `node:child_process` (two modes: via Docker / directly on the host)
- External GUI launch: spawn WinMerge etc. (detached)

## 2. Design philosophy (keep to this when modifying)

| Principle | Reason | Implications when modifying |
|---|---|---|
| **Read-only** | Safety measure so the AI cannot make accidental changes | Subcommands not in the `READ_ONLY_SUBCOMMANDS` allowlist of `SvnClient.execSvn` cannot run. commit/delete/copy/move/import/add/revert/update/merge/lock/propset/mucc etc. are deliberately excluded. Start from here when judging any new tool |
| **Minimal dependencies** | Reduce supply-chain risk | Be careful about adding new npm packages. If the standard API suffices, do not add one |
| **Docker / direct both supported** | Work even in environments without svn on the host | With `useDocker=true`, run via `docker compose exec -T <service> svn ...`, spawned with `composeDir` as the CWD |
| **Tool descriptions = the LLM's user manual** | The LLM reads the description to decide how to use a tool | Write descriptions carefully. Whenever behavior changes, update the description too |
| **Structured errors** | So the LLM can self-correct | Return `SvnError` carrying `code` / `stderr` / `stdout`. The text should state "what caused it" |
| **GUI launch is detached** | The MCP server should respond immediately | `showDiffExternal` uses `spawn(... { detached: true, stdio: "ignore" })` + `child.unref()`. It does not wait for exit |

## 3. Overall structure

```
src/
├── index.ts              Entry point. Load .env → create SvnClient → register tools → start MCP
├── svn/
│   └── client.ts         svn command wrapper (spawn, read-only allowlist, Docker/direct switch, timeout)
├── external/
│   ├── diff-tool.ts      Launch external diff tool (WinMerge etc.) (write temp files + detached spawn)
│   ├── tortoise.ts       Launch TortoiseProc.exe (detached spawn)
│   └── explorer.ts       Launch Windows Explorer (detached spawn; file/folder detection via fs.statSync)
├── wc/
│   ├── scanner.ts        Recursive walk of the working copy and binary-detection helpers (used by find_path / grep_in_repo)
│   └── freshness.ts      Compare the WC revision with the repository HEAD (reported by svn_describe)
└── tools/
    ├── context.ts             Shared tool infrastructure (ToolContext / textResult / jsonResult / errorResult / runSvn)
    ├── svn-describe.ts        "Self-introduction" tool called at session start (info + list + tool availability)
    ├── svn-info.ts            svn info
    ├── svn-list.ts            svn list
    ├── svn-log.ts             svn log
    ├── svn-cat.ts             svn cat
    ├── svn-diff.ts            svn diff
    ├── svn-blame.ts           svn blame (last-modified revision and author per line)
    ├── find-path.ts           File-name search in the WC (fast)
    ├── grep-in-repo.ts        Text grep in the WC (fast, skips binaries)
    ├── show-diff-external.ts  Show a diff in an external GUI (WinMerge etc.)
    ├── show-log-tortoise.ts   Open the TortoiseSVN log dialog
    └── open-in-explorer.ts    Open in Windows Explorer
```

### Layer structure

```
MCP client (Copilot CLI / Claude Code)
        ↓ MCP protocol (stdio)
index.ts (each registered tool)
        ↓
tools/*.ts (argument validation, formatting)
        ↓ via ToolContext
svn/client.ts (svn command execution)        external/diff-tool.ts (GUI launch)
        ↓                                          ↓
   docker compose exec / direct svn              WinMerge etc.
        ↓
   SVN repository (file:// or https://)
```

## 4. Request lifecycle

Using `svn_log` as an example:

1. The LLM calls `svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })`
2. The handler registered by `index.ts` runs; zod validates the arguments
3. The handler calls `ctx.svn.log(path, { limit, verbose, ... })`
4. `SvnClient.log()` builds the argument list `svn log --limit 10 -v <repoUrl>/trunk/src/foo.cpp`
5. `SvnClient.execSvn()` checks the allowlist and `buildCommand()` chooses Docker / direct
6. `spawnAsync()` launches the real process, collects stdout / stderr, and kills on timeout
7. On exit code 0 the stdout is returned; on non-zero, `SvnError` is thrown
8. The handler wraps stdout in `textResult(stdout)` as an MCP response; `SvnError` is returned via `errorResult(message, detail)`

## 5. Module responsibilities

### `index.ts`
- Loads configuration from `.env` (`SVN_REPO_URL` / `SVN_USE_DOCKER` / `SVN_COMPOSE_DIR` / `SVN_DOCKER_SERVICE` / `SVN_TIMEOUT_MS` / `SVN_EXTERNAL_DIFF_TOOL` / `SVN_TORTOISE_PROC` / `SVN_REPO_URL_CLIENT` / `SVN_WORKING_COPY`)
- Throws at startup on inconsistent configuration (`SVN_REPO_URL` unset, `SVN_USE_DOCKER=true` without `SVN_COMPOSE_DIR`, etc.)
- Creates `SvnClient` and the optional `DiffToolConfig` / `TortoiseConfig` / `ExplorerConfig` and assembles the `ToolContext`
- Calls each tool's `register(server, ctx)`
- **When adding a tool, add the import and register call here**

### `svn/client.ts`
- **READ_ONLY_SUBCOMMANDS allowlist**: only `info` / `list` / `ls` / `log` / `cat` / `diff` / `blame` / `praise` / `annotate` / `stat` / `status` / `help` / `--version` pass. Anything else is rejected immediately with `SvnError`. Checked at the top of `execSvn()`
- **Docker / direct switch** (`buildCommand`): with `useDocker=true`, runs `docker compose exec -T <service> svn ...` with `composeDir` as the CWD. With `useDocker=false`, spawns the host's `svn` directly
- **Always non-interactive**: `execSvn()` inserts `--non-interactive` after the subcommand, so a missing credential fails immediately with svn's error instead of hanging the headless server on a prompt
- **Timeout** (`spawnAsync`): after `timeoutMs`, `child.kill()` and the error explicitly says it timed out. stdout/stderr are collected as `Buffer` chunks and decoded once on close, so multibyte characters split across chunks are not garbled
- High-level API (`info` / `list` / `log` / `cat` / `diff` / `blame`). A thin layer that only assembles `svn` CLI arguments
- **`resolveUrl(path)` supports two forms** (async):
  - Omitted: returns `SVN_REPO_URL`
  - Starts with `'/'`: relative to the repository root (via `getRepositoryRoot()`) → `<repo-root>/<path>`
  - No leading `'/'`: relative to `SVN_REPO_URL` → `<SVN_REPO_URL>/<path>`
  - The "Changed paths" output of `svn log -v` (`/branches/X/...`) can be passed as-is
  - Pre-processing: `\` is normalized to `/`; if the first segment of a relative path equals the last segment of `SVN_REPO_URL`, that one segment is stripped so that externally-sourced paths do not produce a doubled URL (`.../src/src/...`)
- **`resolveTarget(path)`** decides whether svn is given the repository URL or a local WC path. When `SVN_WORKING_COPY` is set and `useDocker=false`, a target inside the checkout that exists on disk is passed as the WC path (rides on the WC's cached credentials); anything else falls back to the URL. There is no exception-driven retry — the choice is deterministic so the origin of the data is never ambiguous. `list` / `log` / `cat` / `blame` / `diff` use it; `info` deliberately stays URL-based because `svn info <wc-path>` reports the BASE revision, which would break `head_revision` in `svn_describe`. `log` on a WC path adds `-r HEAD:1` when no range is given, because the WC default (`BASE:1`) would drop commits newer than the checkout
- **`getRepositoryRoot()`**: resolved from `svn info <SVN_WORKING_COPY>` when a WC is available (avoids a URL request), otherwise from `svn info <SVN_REPO_URL>`; parsed from `Repository Root: ...` and cached in `this.repositoryRoot`
- Every method **returns svn's raw stdout string as-is** (no parsing; the LLM can read it as text)

### `external/diff-tool.ts`
- `showDiffExternal(svn, config, args)`:
  1. Fetches the contents of both revisions with `svn.cat(revisionBefore, path)` and `svn.cat(revisionAfter, path)`
  2. Writes left/right files to `os.tmpdir() + svn-mcp-diff-XXXX/` (named `r<rev>_<basename>`)
  3. Launches the GUI with `spawn(toolPath, [leftFile, rightFile], { detached: true, stdio: "ignore" })`
  4. `child.unref()` and returns `{ leftFile, rightFile, tool, pid }` without waiting for the tool to exit
- **The MCP server must run on the host OS (Windows/macOS)** (a GUI launched inside Docker is not visible)

### `external/tortoise.ts`
- `showLogInTortoise(config, fallbackBaseUrl, args)`:
  1. Builds the target path by joining `config.clientRepoBase` (falls back to `fallbackBaseUrl` = `SvnConfig.repoUrl` when unset) with `args.path`
  2. Launches TortoiseProc.exe with `spawn(procPath, ["/command:log", "/path:<target>", "/closeonend:0"], { detached: true })`
  3. `child.unref()` and returns `{ tool, pid, targetPath }` without waiting for the tool to exit
- **Assumes a Windows host**. If `SVN_REPO_URL` is not reachable from Windows (e.g. a `file://` path inside Docker), specify a Windows-reachable URL / working copy separately via `SVN_REPO_URL_CLIENT`

### `external/explorer.ts`
- `openInExplorer(config, args)`:
  1. Joins `config.workingCopyPath` and `args.path` with `path.join`
  2. Determines file vs. folder with `fs.statSync(target, { throwIfNoEntry: false })`
  3. For a file: `spawn("explorer.exe", ["/select,<target>"])`; for a folder: `spawn("explorer.exe", ["<target>"])`
  4. `detached: true` + `child.unref()` for an immediate response
- **Windows only**. `SVN_WORKING_COPY` is kept separate from `SVN_REPO_URL_CLIENT` (for Tortoise) because Tortoise also accepts URLs, whereas Explorer only accepts local paths

### `tools/context.ts` (shared infrastructure)
- `ToolContext` type: `{ svn: SvnClient; diffTool?: DiffToolConfig; tortoise?: TortoiseConfig; explorer?: ExplorerConfig }` — each optional config gates the corresponding GUI tool
- `ToolResult` type and helpers:
  - `textResult(text)` — plain-text response
  - `jsonResult(data)` — JSON.stringify-ed response (used by `show_diff_external`)
  - `errorResult(message, detail?)` — response with `isError: true`
  - `runSvn(fn)` — runs an svn call and converts `SvnError` into `errorResult`
  - `sliceLines(text, start?, end?)` — 1-based inclusive line-range slice used by `svn_cat` / `svn_blame` for `start_line` / `end_line`

### `tools/*.ts` (each tool)
- One file per tool
- Exports `register(server: McpServer, ctx: ToolContext)`
- Inside, calls `server.registerTool(name, { title, description, inputSchema }, handler)`
- Common pattern of wrapping `SvnError` in `errorResult`

## 6. Tool implementation pattern

Every tool has the same shape:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SvnError } from "../svn/client.js";
import { textResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  someArg: z.string().optional().describe("Description of the argument (read by the LLM)"),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "tool_name",
    {
      title: "Short human-readable name",
      description: "Detailed description for the LLM. Say when and how to use it.",
      inputSchema: inputShape,
    },
    async (args) => {
      try {
        const out = await ctx.svn.someMethod(args.someArg);
        return textResult(out);
      } catch (err) {
        if (err instanceof SvnError) {
          return errorResult(err.message, err.detail);
        }
        throw err;
      }
    },
  );
}
```

## 7. Key mechanisms

### Read-only guarantee

So that a destructive subcommand cannot run even if it sneaks in through an LLM generation mistake or prompt injection, `SvnClient.execSvn()` checks against the `READ_ONLY_SUBCOMMANDS` allowlist at its entry point. When adding a new tool, check whether the subcommand it needs is there (if not, **do not widen** the allowlist — instead reconsider whether it is truly a read-only operation).

### Docker mode

With `useDocker=true`, commands run in the form `docker compose exec -T <service> svn ...`:
- `-T` means no TTY allocation (required when driving from spawn)
- `cwd` is set to `composeDir` so that `docker compose` picks up the compose file in that directory
- The service must **contain the svn command** (if not, add `apt-get install -y subversion` or similar to the Dockerfile)

### Constraints on launching the external diff tool

- The GUI will not appear unless the MCP server runs on the host OS (a GUI launched inside Docker is not visible to the user)
- If `SVN_EXTERNAL_DIFF_TOOL` is unset, the `show_diff_external` tool is still registered but returns a "not configured" error when called (the other tools work normally)
- Temp files are created in `os.tmpdir()` and left to OS cleanup (no explicit deletion — deleting them while WinMerge etc. still holds them causes problems)

### Ways to specify `svn diff`

There are 3:
- **`changeRev` only**: diff of a single revision (`svn diff -c REV`)
- **`fromRev` + `toRev`**: diff of a range (`svn diff -r FROM:TO`)
- Neither: working-copy diff (not normally used in Docker / URL-based operation)

The tool side (`tools/svn-diff.ts`) validates at runtime that "either `change_rev` or `from_rev`+`to_rev` is required" (a condition zod alone cannot express).

## 8. How to extend

### Add a new read-only tool

Example: adding `svn_blame`

1. Add a `blame(rev, path)` method to `SvnClient` in `src/svn/client.ts` (`blame` is already in `READ_ONLY_SUBCOMMANDS`)
2. Create `src/tools/svn-blame.ts` (using `svn-info.ts` as a template is quickest)
3. Export `register(server, ctx)`
4. Add the import and `register()` call to `src/index.ts`
5. Add the specification to `docs/TOOLS.md`
6. `npm run build`

### If you are tempted to add write operations (caution)

By design, write operations are not implemented ("do not let the AI make accidental changes"). If you absolutely must:

- You would have to change the name and philosophy of `READ_ONLY_SUBCOMMANDS` → the code's safety boundary disappears
- It is safer to fully separate it as a different binary (e.g. `svn-mcp-write`)
- Credential handling increases (commit needs credentials)

### Making the Docker service name variable

Currently `SVN_DOCKER_SERVICE` fixes a single service. To manage multiple repositories as separate services, you would need an API change adding a `service` tool argument passed through to `SvnClient` (not implemented since there is no demand for it yet).

## 9. Things to watch when changing code (pitfalls)

- **Do not forget to update descriptions**: when behavior changes, fix the tool's `description` too. The LLM acts on it, so a mismatch causes misbehavior.
- **Do not loosen `READ_ONLY_SUBCOMMANDS`**: when adding a new subcommand, ask "does this really have no side effects?" `update` / `revert` / `merge` etc. modify the working copy.
- **cwd in Docker mode**: without `SVN_COMPOSE_DIR`, `docker compose` errors out. It is required when `useDocker=true`.
- **Timeout**: `SVN_TIMEOUT_MS` defaults to 30 seconds. It kicks in for `svn list -R` on large repositories or long `svn log` runs, so extend it in `.env` if needed.
- **Launch GUI tools on the host OS**: if the MCP server runs in WSL or Docker, WinMerge launches but does not appear on the Windows side.
- **stdout is read as UTF-8**: fetching a binary file with `svn_cat` yields garbage. The `svn_cat` description also warns about this. There is no binary detection (the caller decides by extension etc.).
- **Do not write personal information**: do not put real folder paths, real repository names, or real host names in git-tracked files (src, docs, README, `.env.example`). Confine them to `.env` (untracked).

## 10. Verification

```bash
npm run build         # build (tsc)
npm run typecheck     # type check only

# Connectivity test against a real SVN (requires .env)
npm run dev           # start with tsx; waits for the MCP protocol on stdin/stdout
```

Starting with `npm run dev` prints `[svn-mcp] started (repo=..., docker=...)` on stderr. If `SVN_EXTERNAL_DIFF_TOOL` is unset, a warning that `show_diff_external` is unavailable is also printed.

## 11. Constraints

- **Read-only**: by design. No write API is implemented
- **Docker mode**: assumes `docker compose` v2. `docker-compose` (v1) is not supported
- **GUI launch**: the MCP server must be running on the host OS (extra setup is needed inside Docker / WSL2)
- **UTF-8 assumed**: the output of `svn cat` is read as UTF-8. Binary files and other encodings cannot be handled
