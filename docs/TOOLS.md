# svn-mcp tool specifications

Detailed specifications of the MCP tools provided by this server. **The source** `src/tools/*.ts` **is the primary reference**; this document is a human-readable summary. Regenerate it when the specifications change.

## Table of contents

| Tool | Purpose | Source |
|---|---|---|
| [svn_describe](#svn_describe) | Fetch a repository overview (URL, HEAD, top_level, tool availability) in one call | [src/tools/svn-describe.ts](../src/tools/svn-describe.ts) |
| [svn_info](#svn_info) | Info for the repository / a path (HEAD revision, etc.) | [src/tools/svn-info.ts](../src/tools/svn-info.ts) |
| [svn_list](#svn_list) | List files / directories | [src/tools/svn-list.ts](../src/tools/svn-list.ts) |
| [svn_log](#svn_log) | Commit history (path/limit/range/verbose) | [src/tools/svn-log.ts](../src/tools/svn-log.ts) |
| [svn_cat](#svn_cat) | File contents at a given revision | [src/tools/svn-cat.ts](../src/tools/svn-cat.ts) |
| [svn_diff](#svn_diff) | Unified diff (single revision or range) | [src/tools/svn-diff.ts](../src/tools/svn-diff.ts) |
| [svn_blame](#svn_blame) | Last-modified revision and author per line | [src/tools/svn-blame.ts](../src/tools/svn-blame.ts) |
| [find_path](#find_path) | File-name search in the WC (requires SVN_WORKING_COPY) | [src/tools/find-path.ts](../src/tools/find-path.ts) |
| [grep_in_repo](#grep_in_repo) | Text grep in the WC (requires SVN_WORKING_COPY) | [src/tools/grep-in-repo.ts](../src/tools/grep-in-repo.ts) |
| [show_diff_external](#show_diff_external) | Show a diff in an external GUI (WinMerge etc.) | [src/tools/show-diff-external.ts](../src/tools/show-diff-external.ts) |
| [show_log_tortoise](#show_log_tortoise) | Open the TortoiseSVN log dialog | [src/tools/show-log-tortoise.ts](../src/tools/show-log-tortoise.ts) |
| [open_in_explorer](#open_in_explorer) | Open in Windows Explorer | [src/tools/open-in-explorer.ts](../src/tools/open-in-explorer.ts) |

---

## Common design principles

- **Read-only**: only the read-only subcommands of `svn` are allowed (guaranteed by the allowlist in `SvnClient`). commit / delete / copy / move / import / add / revert / update / merge / lock / propset etc. cannot be executed
- **Raw svn output is returned**: each tool returns the stdout of `svn` as text, unmodified. The LLM reads the same text a human would
- **Docker / direct both supported**: switched via `SVN_USE_DOCKER` in `.env` (default `true`)
- **UTF-8 assumed**: the output of `svn_cat` is treated as UTF-8. Do not use it on binary files
- **Paths can be absolute or relative**: a `path` argument that `starts with '/'` is an absolute path from the repository root; one `without a leading '/'` is resolved as relative to `SVN_REPO_URL`. The "Changed paths" output of `svn log -v` (in the `/branches/...` form) can be used as-is
- **Messages emitted by the server** (error text, the `message` field of JSON results) are currently in Japanese. Where this document quotes them verbatim, an English gloss follows in parentheses

---

## svn_describe

### What it does

Returns a "self-introduction" of the repository. Intended to be **called first at the start of a session**.
Prevents the LLM from getting "lost" without knowing what is where.

Internally runs `svn info` and `svn list` once each in parallel and returns the merged result.

### Arguments

None.

### Return value

```jsonc
{
  "repo_url": "file:///svn-repo/my-repo",
  "repository_root": "file:///svn-repo/my-repo",   // Repository Root from svn info
  "repo_url_is_deep": false,                        // true if SVN_REPO_URL is deeper than the root
  "docker_mode": true,
  "head_revision": 142,
  "top_level": ["branches/", "tags/", "trunk/"],
  "tools_available": {
    "show_diff_external": true,    // SVN_EXTERNAL_DIFF_TOOL is set
    "show_log_tortoise": false,    // SVN_TORTOISE_PROC is unset
    "open_in_explorer": true       // SVN_WORKING_COPY is set
  },
  "hint": "trunk / branches / tags の標準レイアウト。ファイル探索は通常 trunk/ 配下から始める。",
  "info_raw": "Path: ...\nURL: ...\nRevision: 142\n..."
}
```

`hint` is generated automatically from the presence of `trunk/` `branches/` `tags/`. For the standard layout it says (in Japanese) "standard trunk / branches / tags layout; start file exploration under trunk/"; otherwise "look at top_level to judge the structure".

### Common queries

```
Preparation at session start
→ svn_describe()
→ Build the paths for subsequent svn_log / svn_diff calls from the returned content
```

### Notes

- It runs svn twice, so calling it every time has some cost. **Once at session start** is enough
- Tool availability is determined by `.env` at MCP server startup. After changing `.env`, restart the MCP client for it to take effect

---

## svn_info

### What it does

Runs `svn info` and returns metadata for the repository or the given path (URL, last revision, last author, last changed date, etc.).

- Confirm the repository exists
- Get the HEAD revision number (e.g. to use as `to_rev` in other tools)
- Check "does this path really exist"

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | — | repository root | Relative path in the repository (e.g. `trunk`, `trunk/src/foo.cpp`) |

### Return value

The raw stdout of `svn info` as a string. Example:

```
Path: trunk
URL: file:///svn-repo/my-repo/trunk
Relative URL: ^/trunk
Repository Root: file:///svn-repo/my-repo
Repository UUID: 12345678-...
Revision: 142
Node Kind: directory
Last Changed Author: alice
Last Changed Rev: 142
Last Changed Date: 2026-05-19 13:26:22 +0900 (Tue, 19 May 2026)
```

### Common queries

```
Check the repository HEAD
→ svn_info()                    # Revision: 142

Check the last author of trunk
→ svn_info({ path: "trunk" })

Check whether a specific file exists
→ svn_info({ path: "trunk/src/foo.cpp" })   # SvnError if it does not exist
```

---

## svn_list

### What it does

Returns a file / directory listing via `svn list` (or `svn list -R` with recursion).

- Find the real path from a file name mentioned in a ticket
- Confirm the existence of a file to be modified
- Enumerate all files recursively

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | — | repository root | Relative path in the repository (e.g. `trunk/src`) |
| `recursive` | boolean | — | `false` | true for `-R` (recursive). Output becomes huge on large repositories |

### Return value

The raw stdout of `svn list`.

```
README.md
package.json
src/
src/index.ts
src/tools/
```

With `recursive=true`, the contents of subdirectories are all included.

### Common queries

```
List directories / files directly under trunk
→ svn_list({ path: "trunk" })

Enumerate everything under src (recursive)
→ svn_list({ path: "trunk/src", recursive: true })
```

### Notes

- Calling with `recursive=true` on a large repository produces very long output and consumes many tokens. Use only when needed
- Directories are marked with a trailing `/`, so filter on the caller side if you only want file names

---

## svn_log

### What it does

Returns commit history via `svn log`.

**The most-used tool**. The starting point for identifying "which recent commits changed this path".

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | — | whole repository | Relative path in the repository. When given, only the change history of that path |
| `limit` | integer (>0) | — | none (all) | Upper bound on the number of commits (`--limit N`). For files with long histories, keep it around 20–50 |
| `verbose` | boolean | — | `false` | true to include the list of changed paths (A/M/D) for each commit (`-v`) |
| `from_rev` | integer or string | — | — | Start revision of a range (used with `to_rev`. Mutually exclusive with the date range) |
| `to_rev` | integer or string | — | — | End revision of a range (e.g. `200` or `"HEAD"`) |
| `from_date` | string (YYYY-MM-DD) | — | — | Start of a date range (used with `to_date`. Mutually exclusive with the revision range) |
| `to_date` | string (YYYY-MM-DD) | — | — | End of a date range |
| `message_contains` | string | — | — | Substring search over commit message / author / changed paths (`svn log --search`) |

If only one of `from_rev` / `to_rev` is given, the missing side is filled in with `1` / `HEAD` respectively (behavior of `SvnClient.log`).

### Return value

The raw stdout of `svn log` (with the changed-paths list if `-v` was given).

```
------------------------------------------------------------------------
r142 | alice | 2026-05-19 13:26:22 +0900 (Tue, 19 May 2026) | 1 line
Changed paths:
   M /trunk/src/foo.cpp
   A /trunk/src/bar.cpp

Refactor: extract common processing into utils
------------------------------------------------------------------------
r141 | bob | 2026-05-18 09:11:03 +0900 (Mon, 18 May 2026) | 1 line
...
```

### Common queries

```
The 10 most recent commits that changed a specific file
→ svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })

All commits in a revision range (100–HEAD)
→ svn_log({ from_rev: 100, to_rev: "HEAD", verbose: true })

The 5 most recent commits in the whole repository
→ svn_log({ limit: 5 })

Search for commits containing ticket number #1234
→ svn_log({ message_contains: "#1234" })

Narrow by date range (around the date a ticket was filed)
→ svn_log({ from_date: "2026-04-10", to_date: "2026-04-20", path: "trunk/src" })

Combined: login-related commits under trunk in April
→ svn_log({
    path: "trunk",
    message_contains: "login",
    from_date: "2026-04-01",
    to_date: "2026-04-30"
  })
```

### Notes

- When `path` is given, commits that did not touch that path are not shown
- `verbose=true` inflates the output, but is useful for guessing which files are relevant
- `message_contains` searches **across commit message, author, and changed paths**, so passing an author name also works (though it may match other fields too)
- The revision range (`from_rev`/`to_rev`) and the date range (`from_date`/`to_date`) are **mutually exclusive**. Specifying both is an error

---

## svn_cat

### What it does

Returns the file contents at the given revision via `svn cat -r REV PATH`.

- Compare before / after a fix (hunk by hunk)
- Check "what did the code look like at this revision"
- Cross-check against log messages

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `revision` | integer (>0) or `"HEAD"` | ✓ | — | Revision number, or `"HEAD"` |
| `path` | string | ✓ | — | Relative path in the repository (e.g. `trunk/src/foo.cpp`) |

### Return value

The file contents themselves (as UTF-8 text).

### Common queries

```
foo.cpp at r142
→ svn_cat({ revision: 142, path: "trunk/src/foo.cpp" })

Latest version
→ svn_cat({ revision: "HEAD", path: "trunk/README.md" })
```

### Notes

- **Do not use on binary files**: the output is read as UTF-8, so images, executables, etc. become garbage
- Large files produce large responses. If needed, narrow the line range on the caller side (svn has no line-range API, so the practice is to fetch the whole file and slice)
- To cat a file at a revision after it was deleted, specify a revision number from before the deletion

---

## svn_diff

### What it does

Returns a unified diff via `svn diff`.

- Changes of a single revision (`-c REV`)
- Diff over a revision range (`-r FROM:TO`)
- Diff narrowed to a specific file

Used for hunk-level analysis, or extracting a fix from a commit that mixes several tickets' changes.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `change_rev` | integer (>0) | — | — | Diff of a single revision (`-c REV`). Use when not using `from_rev`/`to_rev` |
| `from_rev` | integer (>0) | — | — | Start revision of a range diff (used with `to_rev`) |
| `to_rev` | integer (>0) or `"HEAD"` | — | — | End revision of a range diff (used with `from_rev`) |
| `path` | string | — | whole revision | Narrow to a specific path (e.g. `trunk/src/foo.cpp`) |

**Either `change_rev` or `from_rev`+`to_rev` is required**. Specifying neither is an error.

### Return value

The raw text of the unified diff. When there is no difference: `(差分なし)` (meaning "no differences").

```
Index: trunk/src/foo.cpp
===================================================================
--- trunk/src/foo.cpp	(revision 141)
+++ trunk/src/foo.cpp	(revision 142)
@@ -10,7 +10,7 @@
-  const TIMEOUT_MS = 3000;
+  const TIMEOUT_MS = 30000;
```

### Common queries

```
All changes in r142
→ svn_diff({ change_rev: 142 })

Only the foo.cpp change within r142
→ svn_diff({ change_rev: 142, path: "trunk/src/foo.cpp" })

Cumulative diff of foo.cpp from r100 to HEAD
→ svn_diff({ from_rev: 100, to_rev: "HEAD", path: "trunk/src/foo.cpp" })
```

### Notes

- The full diff of a large commit produces huge output. Narrowing with `path` is the norm
- Binary files show up as a line like `Cannot display: file marked as a binary type.` with no content (svn behavior)

---

## svn_blame

### What it does

For the given path, returns **the "last-modified revision and author" of every line** (`svn blame PATH`).

The standard way to answer "**when and by whom was this bug introduced?**" or "why is this line like this?". The usual flow is to take the revision number found via blame as the starting point and call `svn_log` / `svn_diff` / `svn_cat` to identify the causing commit.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | ✓ | — | Relative path in the repository. Text files only |
| `revision` | integer (>0) or `"HEAD"` or digit string | — | `HEAD` | Revision at which to take the blame |

### Return value

The raw stdout of `svn blame`. Example:

```
   140    alice  #include <stdio.h>
   140    alice
   142    bob    int main(int argc, char **argv) {
   142    bob      const int TIMEOUT_MS = 30000;
   138    alice    printf("hello\n");
   142    bob      return 0;
   140    alice  }
```

From left to right: revision number, author, line content.

### Common queries

```
Who is responsible for line 42 of foo.cpp?
→ svn_blame({ path: "trunk/src/foo.cpp" })
→ Look at line 42 in the result, then dig into that revision with svn_log or svn_diff

Blame as of a past revision
→ svn_blame({ path: "trunk/src/foo.cpp", revision: 100 })
```

### Typical bug-investigation flow

```
1. Use svn_blame to find the last-modified revision X of the problematic line
2. svn_log({ from_rev: X, to_rev: X, verbose: true }) to see what that commit did
3. svn_diff({ change_rev: X, path: "..." }) to see the concrete change
4. If needed, compare whole files before / after with svn_cat
```

### Notes

- **Do not use on binary files**: text is assumed
- **Large files are slow**: svn walks the entire history, so huge files respond slowly
- Deleted files cannot be blamed (work around by specifying a past revision)

---

## find_path

### What it does

Performs a **substring search on WC-relative paths** under the working copy (local WC). A file name, folder name, or any part of the path matches. Answers "where is `foo.cpp`?" or "files under `src/external`" instantly without hitting the SVN server.

Faster and cheaper in tokens than fetching the whole repository with `svn list -R` and grepping on the LLM side.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `pattern` | string | ✓ | — | **Substring** pattern for the WC-relative path (case-insensitive, `\` → `/` normalized). May appear anywhere in the file name, folder name, or full path |
| `base` | string | — | whole WC | Relative starting point from the WC root (e.g. `trunk/src`) |
| `limit` | integer | — | `50` | Upper bound on returned results (max 500) |

### Return value

```jsonc
{
  "wc_path": "C:\\path\\to\\wc",
  "base": null,
  "pattern": "foo.cpp",
  "matches": [
    { "path": "trunk/src/foo.cpp", "type": "file" },
    { "path": "branches/release-1.0/src/foo.cpp", "type": "file" }
  ],
  "count": 2,
  "files_scanned": 8421,
  "truncated": false,
  "note": null,
  "warning": "WC ベースの検索です。最近 svn update してない場合、新規追加ファイルが出ない可能性あり。"
}
```

(`warning` means: "This is a WC-based search. If you have not run svn update recently, newly added files may not appear.")

### Prerequisites

- `SVN_WORKING_COPY` must be set
- The WC must be up to date (`svn update` is required to find newly added files)

### Common queries

```
Where is foo.cpp?
→ find_path({ pattern: "foo.cpp" })

Narrow by sub-path
→ find_path({ pattern: "src/external/foo.cpp" })

Pass an externally-sourced path as-is (OK even if the prefix does not exist in the WC, as long as the tail matches)
→ find_path({ pattern: "XYZ/my-repo/extend/foo.cpp" })

Enumerate everything under a folder
→ find_path({ pattern: "extend/" })

Only cpp files under trunk/src
→ find_path({ pattern: ".cpp", base: "trunk/src" })
```

### Important use: normalizing externally-sourced paths

Path strings that appear in ticketing-tool bodies or conversation (e.g. `XYZ/my-repo/extend/foo.cpp`, with a project-name prefix) can be **passed as-is to normalize them**.

```
External input: "XYZ/my-repo/extend/foo.cpp"
→ find_path({ pattern: "XYZ/my-repo/extend/foo.cpp" })
→ Hits if the tail of the path, "extend/foo.cpp", is contained in a WC path
→ matches: [{ path: "trunk/src/extend/foo.cpp" }]   // the correct WC-relative path
→ Use this for subsequent svn_log / svn_diff → fundamentally avoids doubled URLs
```

No basename extraction is needed (it is a substring match on any part of the path, so pass it as-is). For details, see "Normalize externally-sourced paths with find_path before using them" in [copilot-instructions.example.md](../copilot-instructions.example.md).

### Notes

- `.svn` directories are skipped automatically
- Case-insensitive ("FOO.cpp" and "foo.cpp" both hit)
- `\` is normalized to `/` automatically, so Windows separators are fine
- Short patterns (`"src"` etc.) tend to produce many hits. Query with specific names as a rule

---

## grep_in_repo

### What it does

**Greps text files** in the working copy (local WC) for a keyword. Pinpoints "where is the function `do_login` called" or "which code emits this error message" in one shot.

Fast because it does not hit the `svn` server. Binary and huge (>2MB) files are skipped automatically.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | ✓ | — | Search string. A regular expression when `is_regex: true` |
| `is_regex` | boolean | — | `false` | true to interpret query as a regular expression |
| `case_insensitive` | boolean | — | `false` | Ignore case |
| `path_filter` | string | — | — | Substring filter on the file name (e.g. `.cpp`) |
| `base` | string | — | whole WC | Starting point of the search |
| `max_results` | integer | — | `100` | Upper bound on hits (max 1000) |

### Return value

```jsonc
{
  "wc_path": "C:\\path\\to\\wc",
  "query": "do_login",
  "is_regex": false,
  "case_insensitive": false,
  "path_filter": ".cpp",
  "base": null,
  "hits": [
    { "path": "trunk/src/auth.cpp", "line": 42, "text": "void do_login(User &user) {" },
    { "path": "trunk/src/main.cpp", "line": 100, "text": "  do_login(current_user);" }
  ],
  "hit_count": 2,
  "files_scanned": 1234,
  "skipped_binary": 89,
  "skipped_large": 3,
  "truncated": false,
  "note": null,
  "warning": "WC ベースの検索です。最近 svn update してない場合、最新の変更が反映されていない可能性あり。"
}
```

(`warning` means: "This is a WC-based search. If you have not run svn update recently, the latest changes may not be reflected.")

### Prerequisites

- `SVN_WORKING_COPY` must be set
- The WC must be up to date (a stale WC does not reflect recent changes)

### Common queries

```
Call sites of do_login
→ grep_in_repo({ query: "do_login" })

Where "Connection refused" is emitted
→ grep_in_repo({ query: "Connection refused" })

Regular expression, cpp files only
→ grep_in_repo({
    query: "TODO|FIXME",
    is_regex: true,
    path_filter: ".cpp"
  })

Case-insensitive under trunk/src
→ grep_in_repo({
    query: "logger",
    case_insensitive: true,
    base: "trunk/src"
  })
```

### Skip conditions

| Kind | Details |
|---|---|
| Binary extensions | `.exe` `.dll` `.png` `.pdf` `.zip` etc. are skipped immediately by extension |
| Huge files | Over 2 MB |
| Contains NUL bytes | Treated as binary if there is a `\0` in the first 512 bytes |
| Overly long lines | A line over 500 characters is treated as minified etc. and skipped |
| Under `.svn/` | Always skipped |

### Notes

- On a large repository, "no `path_filter` + a common word" yields enormous results. Narrow as much as possible
- A regular-expression error is returned immediately as an error response
- Displayed lines are truncated to 200 characters with `…`

---

## show_diff_external

### What it does

Writes the given 2 revisions × file path to temp files and launches an **external GUI diff tool** (WinMerge etc.).

- For a human to **visually verify** fix candidates the LLM identified automatically
- Final check against AI misjudgment
- When you want to see the context (surrounding code) of a fix

Because it launches a GUI, **the MCP server must run on the host OS (Windows/macOS)**. Nothing appears if it runs inside Docker / WSL2.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `revision_before` | integer (>0) | ✓ | — | Revision number before the fix |
| `revision_after` | integer (>0) | ✓ | — | Revision number after the fix |
| `path` | string | ✓ | — | Relative path in the repository |

### Return value

```jsonc
{
  "message": "外部差分ツールを起動しました。",
  "tool": "C:\\Program Files\\WinMerge\\WinMergeU.exe",
  "pid": 12345,
  "left_file": "C:\\Users\\...\\AppData\\Local\\Temp\\svn-mcp-diff-XXXX\\r141_foo.cpp",
  "right_file": "C:\\Users\\...\\AppData\\Local\\Temp\\svn-mcp-diff-XXXX\\r142_foo.cpp"
}
```

(`message` means: "Launched the external diff tool.")

What it executes:
1. Fetches the files with `svn cat -r <revision_before> <path>` and `svn cat -r <revision_after> <path>`
2. Writes them to `os.tmpdir()/svn-mcp-diff-XXXX/r<rev>_<basename>`
3. Spawns `<toolPath> <leftFile> <rightFile>` **detached**
4. Responds immediately without waiting for the tool to exit

### Prerequisites

- `SVN_EXTERNAL_DIFF_TOOL` must be set in `.env`. If unset, calling it returns an error:
  ```
  外部差分ツールが未設定です。環境変数 SVN_EXTERNAL_DIFF_TOOL を .env に設定してください。
  例: SVN_EXTERNAL_DIFF_TOOL=C:\Program Files\WinMerge\WinMergeU.exe
  ```
  (meaning: "The external diff tool is not configured. Set the environment variable SVN_EXTERNAL_DIFF_TOOL in .env. Example: ...")
- The MCP server must be running on the host OS (a GUI does not show inside Docker)

### Common queries

```
Open foo.cpp r141 → r142 in WinMerge
→ show_diff_external({
    revision_before: 141,
    revision_after: 142,
    path: "trunk/src/foo.cpp"
  })
```

### Notes

- Temp files are left to OS cleanup (not deleted explicitly — deleting them while the GUI holds them causes problems)
- Tools other than WinMerge (KDiff3, Beyond Compare, etc.) should also work as long as they can be launched in the `<tool> <left> <right>` form

---

## show_log_tortoise

### What it does

Launches the **TortoiseSVN log dialog** (`TortoiseProc.exe /command:log`) for the given path.

- For a human to **visually verify in TortoiseSVN** fix candidates the LLM inferred
- Performs the same operation as "right-click the target file → TortoiseSVN → Show Log", via the AI
- Lets a human review in the UI they normally use when the reliability of the content is in doubt

Because it launches a GUI, **the MCP server must run on the host OS (Windows)**.

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | — | repository root | Relative path in the repository (e.g. `trunk/src/foo.cpp`, `trunk/src`) |

### Return value

```jsonc
{
  "message": "TortoiseSVN のログダイアログを起動しました。",
  "tool": "C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe",
  "pid": 12345,
  "target_path": "https://svn.example.com/repo/trunk/src/foo.cpp"
}
```

(`message` means: "Launched the TortoiseSVN log dialog.")

What it executes:
1. Builds the target path by joining `SVN_REPO_URL_CLIENT` (falls back to `SVN_REPO_URL` when unset) with `path`
2. Spawns `<TortoiseProc.exe> /command:log /path:<target> /closeonend:0` **detached**
3. Responds immediately without waiting for the tool to exit

### Prerequisites

- `SVN_TORTOISE_PROC` must be set in `.env`. If unset, calling it returns an error:
  ```
  TortoiseSVN が未設定です。環境変数 SVN_TORTOISE_PROC を .env に設定してください。
  例: SVN_TORTOISE_PROC=C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe
  ```
  (meaning: "TortoiseSVN is not configured. Set the environment variable SVN_TORTOISE_PROC in .env. Example: ...")
- The MCP server must be running on the host OS (Windows)
- **`SVN_REPO_URL` must be reachable from TortoiseSVN on the Windows side**. A `file:///svn-repo/...` inside Docker is not visible from Windows; in that case set `SVN_REPO_URL_CLIENT` in `.env` to a Windows-reachable URL (`https://...`, `svn+ssh://...`) or the absolute path of a working copy (`C:\path\to\wc`)

### Common queries

```
Open the log of foo.cpp in TortoiseSVN
→ show_log_tortoise({ path: "trunk/src/foo.cpp" })

Open the log of the trunk/src folder in TortoiseSVN (history including subfolders)
→ show_log_tortoise({ path: "trunk/src" })

Log of the whole repository
→ show_log_tortoise()
```

### Notes

- The starting revision and count in the TortoiseSVN dialog are controlled by the user in the GUI (not by this tool's arguments)
- TortoiseSVN may ask for credentials on first launch. Enter them in the GUI if so

---

## open_in_explorer

### What it does

Opens the given path under the working copy (local WC) in **Windows Explorer**.

- File given → `explorer.exe /select,<file>` opens the parent folder with the file **highlighted**
- Folder given → `explorer.exe <folder>` opens the folder
- Path omitted → opens the WC root

Use it when you first want to open the location in Explorer as a prelude to "right-click the target file and use TortoiseSVN...".

### Arguments

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | — | WC root | Relative path in the repository (e.g. `trunk/src/foo.cpp`, `trunk/src`) |

File vs. folder is detected automatically by checking the real WC with `fs.statSync`.

### Return value

```jsonc
{
  "message": "Windows エクスプローラを起動しました。",
  "tool": "explorer.exe",
  "pid": 12345,
  "target_path": "C:\\path\\to\\working-copy\\trunk\\src\\foo.cpp",
  "selected": true
}
```

(`message` means: "Launched Windows Explorer.")

`selected: true` indicates it was opened in `/select,` mode (file-selection display).

### Prerequisites

- `SVN_WORKING_COPY` must be set in `.env`. If unset, calling it returns an error:
  ```
  作業コピーが未設定です。環境変数 SVN_WORKING_COPY を .env に設定してください。
  例: SVN_WORKING_COPY=C:\path\to\working-copy
  ```
  (meaning: "The working copy is not configured. Set the environment variable SVN_WORKING_COPY in .env. Example: ...")
- The MCP server must be running on a Windows host
- The given path must **actually exist** under `SVN_WORKING_COPY` (even if it is in the repository, it cannot be opened if not checked out in the WC)

### Common queries

```
Open the location of foo.cpp (selected in its parent folder)
→ open_in_explorer({ path: "trunk/src/foo.cpp" })

Open the trunk/src folder
→ open_in_explorer({ path: "trunk/src" })

Open the WC root
→ open_in_explorer()
```

### Notes

- `SVN_WORKING_COPY` is **different** from the SVN repository URL (a local path, not the remote repository URL)
- If the WC is stale, the given file may not exist. A WC that has had `svn update` run is assumed

---

## Common format of error responses

When a tool fails, structured text like the following is returned with `isError: true`:

### `SvnError` (svn command failure)

```
svn が exit code 1 で失敗しました: svn: E170000: URL 'file:///svn-repo/my-repo/notfound' non-existent in revision 142

{
  "code": 1,
  "stderr": "svn: E170000: ...",
  "stdout": ""
}
```

(The first line means: "svn failed with exit code 1: ...")

### Missing arguments (zod validation is a separate error; the tool's runtime validation uses errorResult)

```
change_rev か、from_rev と to_rev の組み合わせを指定してください。
```

(meaning: "Specify either change_rev, or the combination of from_rev and to_rev.")

### Missing configuration

```
外部差分ツールが未設定です。環境変数 SVN_EXTERNAL_DIFF_TOOL を .env に設定してください。
```

(meaning: "The external diff tool is not configured. Set the environment variable SVN_EXTERNAL_DIFF_TOOL in .env.")

---

## Extending

Steps to add a new read-only tool:

1. Add a corresponding method to `SvnClient` in `src/svn/client.ts` (check that the subcommand is in `READ_ONLY_SUBCOMMANDS`)
2. Create `src/tools/your-tool.ts` (using `src/tools/svn-info.ts` as a template is quickest)
3. Export the following:
   ```ts
   export function register(server: McpServer, ctx: ToolContext) {
     server.registerTool("your_tool", { title, description, inputSchema }, async (args) => { ... });
   }
   ```
4. Add the `import` and `register(server, ctx)` call to `src/index.ts`
5. `npm run build` → restart

Regenerate this document from the source as well.

For details, see "8. How to extend" in [ARCHITECTURE.md](ARCHITECTURE.md).
