# svn-mcp

An MCP (Model Context Protocol) server that provides **read-only access** to SVN repositories.
It lets AI agents (GitHub Copilot CLI, Claude Code, etc.) read commit history, file contents, and diffs from SVN.

## What it can do

- "Show me the last 10 commits for trunk/src/foo.cpp"
- "Show the changes in r142 as a unified diff, limited to foo.cpp"
- "Open the r141 → r142 diff in my diff tool so I can eyeball it"
- "Find the commits that touched this path and contain a specific keyword"

## Design principles

- **Read-only**: only `info` / `list` / `log` / `cat` / `diff`. No commit-type operations are implemented (a safety measure so the AI cannot make accidental changes)
- **Works with Docker or directly**: even if the host has no `svn`, the svn inside a Docker container can be driven via `docker compose exec`
- **Optional GUI hand-off**: fix candidates inferred by the LLM can be handed to a human for visual verification in their own diff tool, SVN client, or file manager
- **Minimal dependencies**: only `@modelcontextprotocol/sdk` and `zod`

## Setup (from a clean environment)

### 0. Requirements

- **Node.js 22 or later** (22 LTS or 24 LTS recommended)
  - Check: `node --version`
  - If not installed, get it from https://nodejs.org/
- **svn command** (only when using `SVN_USE_DOCKER=false`; not needed when going through Docker)
- **Docker / Docker Compose v2** (only when using `SVN_USE_DOCKER=true`)
- Git (if you use it to fetch the code)

### 1. Get the code

With git:
```powershell
git clone <this repository URL> svn-mcp
cd svn-mcp
```

If you copied a zip / USB, `cd` into the extracted directory.

### 2. Install dependencies

```powershell
npm install
```

You should see output like `added N packages, found 0 vulnerabilities`.

### 3. Build

```powershell
npm run build
```

This generates the `dist/` directory.

### 4. Create `.env`

PowerShell:
```powershell
Copy-Item .env.example .env
```

Git Bash / WSL:
```bash
cp .env.example .env
```

Open `.env` in an editor and edit it. See the next section for the required entries.

#### Minimal configuration ① — via Docker (no svn on the host)

Use the `svn` inside a container brought up with `docker compose`.

```dotenv
SVN_REPO_URL=file:///svn-repo/my-repo
SVN_USE_DOCKER=true
SVN_COMPOSE_DIR=C:\path\to\your\docker-compose-dir
# SVN_DOCKER_SERVICE=svn        # default "svn". Match your compose service name
```

`SVN_COMPOSE_DIR` is the directory containing `compose.yml`. `SVN_REPO_URL` is the path as seen from inside the container.

#### Minimal configuration ② — host svn directly

If `svn` is installed on the host:

```dotenv
SVN_REPO_URL=https://svn.example.com/repo
SVN_USE_DOCKER=false
```

#### Optional — GUI integrations and working copy

These are all optional. Leaving one unset only disables the corresponding tool; everything else keeps working.

```dotenv
# Any diff tool that can be launched as `<tool> <left-file> <right-file>`.
# Enables show_diff_external.
#SVN_EXTERNAL_DIFF_TOOL=C:\path\to\diff-tool.exe

# Path to TortoiseProc.exe. Enables show_log_tortoise (Windows only).
#SVN_TORTOISE_PROC=C:\path\to\TortoiseProc.exe
# If SVN_REPO_URL is not reachable from Windows (e.g. a file:// path inside Docker),
# give the GUI client a separate base URL or working-copy path:
#SVN_REPO_URL_CLIENT=https://svn.example.com/repo

# Absolute path of a local working copy. Enables open_in_explorer (Windows only)
# and the fast WC-based find_path / grep_in_repo tools.
# This is a local checkout, separate from the SVN repository URL.
#SVN_WORKING_COPY=C:\path\to\working-copy
```

Tools that open a GUI (`show_diff_external` / `show_log_tortoise` / `open_in_explorer`) require the **MCP server to run on the host OS** — a window launched inside Docker / WSL is not visible. See [docs/TOOLS.md](docs/TOOLS.md) for details on each tool.

#### Optional — timeout

```dotenv
SVN_TIMEOUT_MS=60000    # default 30000ms. Increase when svn log/list is slow on large repositories
```

### 5. Verify it works

#### Quick (start only)

```powershell
npm run dev
```

You should see a line like the following on stderr (the server is now waiting for the MCP protocol on stdin/stdout; stop with Ctrl+C):

```
[svn-mcp] started (repo=file:///svn-repo/my-repo, docker=true)
```

#### Recommended (connectivity test)

```powershell
npm run build
npm run smoke
```

This actually calls the main tools (svn_describe / svn_info / svn_list / svn_log / find_path) over the MCP protocol and reports PASS/FAIL.
It is an end-to-end check that includes the real connection to the SVN server, so use it for initial setup and after refactoring.

If `SVN_EXTERNAL_DIFF_TOOL` is unset, you will also see this line:
```
[svn-mcp] SVN_EXTERNAL_DIFF_TOOL 未設定: show_diff_external は利用不可
```
(meaning: `SVN_EXTERNAL_DIFF_TOOL` not set: `show_diff_external` is unavailable)

This is just a warning; the other tools work normally.

If you cannot connect, see [Troubleshooting](#troubleshooting).

### 6. Register with an MCP client

See the next section, "[Registering with MCP clients](#registering-with-mcp-clients)".

## Registering with MCP clients

This project **ships with a `.mcp.json`**, so most MCP clients will pick up the svn MCP server automatically **just by being launched in the project directory**.

### Claude Code

#### Method ① (recommended): automatic `.mcp.json` detection

Simply open VSCode **in this project's folder**. The Claude Code extension detects `.mcp.json` and shows an approval dialog on first launch; click Approve.

To confirm after approval, start a new conversation and ask:

```
Show me the available MCP tools
```

#### Method ②: user settings (to use it from any project)

Add to the `mcpServers` key in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["--env-file=.env", "<absolute path to this project>/dist/index.js"],
      "cwd": "<absolute path to this project>"
    }
  }
}
```

Restart VSCode.

> Even on Windows, use `/` as the path separator inside JSON (`\` requires tedious escaping).

### GitHub Copilot CLI

#### Method ① (recommended): automatic `.mcp.json` detection

Just launch `copilot` in this project directory:

```powershell
cd C:\path\to\svn-mcp
copilot
```

`.mcp.json` is loaded automatically as workspace configuration. To confirm:

```powershell
copilot mcp list
# → OK if it shows "Workspace servers: svn (local)"
```

#### Method ②: user settings (to use it from anywhere)

```powershell
copilot mcp add svn `
  --env SVN_REPO_URL=file:///svn-repo/my-repo `
  --env SVN_USE_DOCKER=true `
  --env SVN_COMPOSE_DIR=C:\path\to\your\docker-compose-dir `
  -- node <absolute path to this project>/dist/index.js
```

> With user settings, the relative path in `--env-file=.env` does not resolve, so pass the environment variables directly with `--env`.

### Using multiple MCP servers together

When combining with other MCP servers (e.g. one for a ticketing tool), the quickest approach is to **create a single `.mcp.json` in a separate directory that points to both**:

```powershell
mkdir C:\path\to\mcp-workspace
# Put the .mcp.json below inside it
cd C:\path\to\mcp-workspace
copilot         # or open VSCode in that folder
```

`C:\path\to\mcp-workspace\.mcp.json`:

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["--env-file=.env", "dist/index.js"],
      "cwd": "C:/path/to/svn-mcp"
    },
    "other-mcp": {
      "command": "node",
      "args": ["--env-file=.env", "dist/index.js"],
      "cwd": "C:/path/to/other-mcp"
    }
  }
}
```

Key points:

- **Always specify `cwd`** — this makes each MCP server **start in its own project directory**. Both `--env-file=.env` and `dist/index.js` are resolved relative to that directory, so each server reads its own `.env`
- Use `/` as the path separator (`\` requires tedious JSON escaping)
- The workspace directory can be otherwise empty (only `.mcp.json` is needed)
- Confirm with `copilot mcp list`, or in Claude Code ask `Show me the available MCP tools`

### General notes

- With the `.mcp.json` approach, **the CWD in which the MCP client is launched must be the project directory**
- After changing values in `.env`, restart the client to respawn the MCP server process (`.env` is only read at process startup)

## Provided tools

| Tool | Purpose |
|---|---|
| `svn_describe` | Fetch the repository URL, HEAD, top-level structure, available tools, and WC freshness in one call (**call this first at the start of a session**) |
| `svn_info` | Info for the repository / a path (HEAD revision, etc.) |
| `svn_list` | List files / directories (`-R` for recursive) |
| `svn_log` | Commit history (path/limit/range/verbose supported) |
| `svn_cat` | Get file contents at a given revision |
| `svn_diff` | Unified diff for a single revision or a range |
| `svn_blame` | Show the "last-modified revision and author" per line (starting point for bug investigation) |
| `find_path` | Fast file-name search in the WC (when `SVN_WORKING_COPY` is set) |
| `grep_in_repo` | Grep text files in the WC (when `SVN_WORKING_COPY` is set) |
| `show_diff_external` | Open 2 revisions × a file in an external diff tool (for humans) |
| `show_log_tortoise` | Open the TortoiseSVN log dialog for a path (for humans) |
| `open_in_explorer` | Open a path under the working copy in Windows Explorer (for humans) |

**For detailed specifications (arguments, return values, sample queries), see [docs/TOOLS.md](docs/TOOLS.md).**

## Adding a tool

1. Add a corresponding method to `SvnClient` in `src/svn/client.ts` (make sure it passes the read-only allowlist)
2. Create `src/tools/your-tool.ts`
3. Export a `register(server, ctx)` function
4. Add the `import` and `register` call to `src/index.ts`

Existing tools can be used as templates. `src/tools/svn-info.ts` is the simplest.

**Before modifying or extending the code, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the design document) first.** It covers the overall structure, design philosophy, extension steps, and pitfalls.

## Expected workflow

A typical flow:

1. User: "I want to see the recent changes to foo.cpp"
2. LLM → svn-mcp: fetch history with `svn_log(path="trunk/src/foo.cpp", limit=10, verbose=true)`
3. LLM → svn-mcp: check the diff for each candidate with `svn_diff(change_rev=N, path=...)`
4. The LLM summarizes the content hunk by hunk and reports things like "X changed in r142"
5. User: "I want to see it with my own eyes"
6. LLM → svn-mcp: `show_diff_external(revision_before=141, revision_after=142, path=...)` → the external diff tool launches

Combined with an MCP server for an external ticketing tool, a flow like "file path written in the ticket → check history and diff in SVN" can be driven end to end by natural-language instructions.

## Troubleshooting

The first five rows quote the actual error text emitted by the server (currently in Japanese), with an English gloss.

| Symptom | Fix |
|---|---|
| `SVN_REPO_URL が設定されていません` (SVN_REPO_URL is not set) | Create / edit `.env` |
| `SVN_USE_DOCKER=true のとき SVN_COMPOSE_DIR の指定が必要です` (SVN_COMPOSE_DIR is required when SVN_USE_DOCKER=true) | Add `SVN_COMPOSE_DIR=...` to `.env` |
| `svn: E170000: URL '...' non-existent in revision N` | `SVN_REPO_URL` is wrong, or the given path does not exist. Check with `svn_info` |
| `svn コマンドが Nms でタイムアウトしました` (svn command timed out after N ms) | Increase `SVN_TIMEOUT_MS`, or drop `recursive` / reduce `limit` |
| `svn-mcp は読み取り専用です。サブコマンド '...' は許可されていません` (svn-mcp is read-only; subcommand '...' is not allowed) | Working as designed. Do write operations with another tool |
| `docker compose exec` does not work | Check that `SVN_COMPOSE_DIR` is the directory containing compose.yml. Verify with `docker compose -f <that dir>/compose.yml ps` |
| The Docker container has no svn | Add `apt-get install -y subversion` or similar to the Dockerfile and rebuild |
| `show_diff_external` / `show_log_tortoise` / `open_in_explorer` reports "not configured" | Add the corresponding `SVN_EXTERNAL_DIFF_TOOL` / `SVN_TORTOISE_PROC` / `SVN_WORKING_COPY` to `.env` |
| `show_log_tortoise` launches the client but it reports "URL not found" or similar | The client on Windows cannot see a `file://` URL inside Docker. Set `SVN_REPO_URL_CLIENT=...` in `.env` to a URL or working-copy path reachable from Windows |
| `open_in_explorer` opens Explorer but the folder does not exist | The path does not exist under `SVN_WORKING_COPY`. Run `svn update` on the WC, or point to a different WC |
| A GUI tool does not launch or does not appear on screen | Check whether the MCP server is running inside Docker / WSL2. It must run on the Windows host OS |
| `svn_cat` output is garbled | Check that you are not cat-ing a binary file. Non-UTF-8 text is also unsupported |
| `svn_log -v` output is too long and exhausts tokens | Reduce `limit`, or specify `path` to narrow down to a specific file |

## Architecture

```
src/
├── index.ts              MCP server startup, tool registration, .env loading
├── svn/
│   └── client.ts         svn command wrapper (read-only allowlist, Docker/direct switch, timeout)
├── external/
│   ├── diff-tool.ts      Launch external diff tool (write temp files + detached spawn)
│   ├── tortoise.ts       Launch the SVN GUI client's log dialog (detached spawn)
│   └── explorer.ts       Launch Windows Explorer (detached spawn)
├── wc/
│   └── scanner.ts        Working-copy walk and binary-detection helpers
└── tools/
    ├── context.ts                Shared tool infrastructure (ToolContext, textResult, jsonResult, errorResult, runSvn)
    ├── svn-describe.ts
    ├── svn-info.ts
    ├── svn-list.ts
    ├── svn-log.ts
    ├── svn-cat.ts
    ├── svn-diff.ts
    ├── svn-blame.ts
    ├── find-path.ts
    ├── grep-in-repo.ts
    ├── show-diff-external.ts
    ├── show-log-tortoise.ts
    └── open-in-explorer.ts
```

The only dependencies are `@modelcontextprotocol/sdk` and `zod` (minimal supply chain). svn is executed via `spawn` from `node:child_process`, environment variables come from `node --env-file`, and external GUIs are launched with a detached spawn.

The detailed design (layer structure, responsibilities of each module, how to extend, things to watch out for when modifying) is documented in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
