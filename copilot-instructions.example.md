# Instruction template for Copilot / Claude Code (svn-mcp)

This file is a **template**. In real use, place it in one of the following locations:

- GitHub Copilot CLI: `~/.copilot/copilot-instructions.md` or `<repo>/.github/copilot-instructions.md`
- Claude Code: `<repo>/CLAUDE.md` or `~/.claude/CLAUDE.md`

The real file (`copilot-instructions.md` / `CLAUDE.md`) is expected to be extended with environment-specific terminology, repository naming conventions, branching practices, and so on, so it is **excluded from tracking** via `.gitignore`. Only the template (`.example.md`) is committed.

---

## How to use svn-mcp (for AI agents)

This project has **svn-mcp** (a read-only MCP server for SVN) registered.
When the user asks about the SVN repository, use the following as a guide to work efficiently.

### Basic principles

- **Call `svn_describe` first at the start of a session** — it tells you the repository URL, HEAD revision, top-level structure (whether trunk/branches/tags exist), available tools, and WC freshness in one call. Skipping this leaves you "lost" without knowing what is where, and leads to wasted tool calls.
- **Paths can be absolute or relative**: the `path` argument of every tool is resolved automatically in **either of two forms**:
  - **Relative** (does not start with `/`, e.g. `extend/foo.c`) → resolved against SVN_REPO_URL
  - **Absolute** (starts with `/`, e.g. `/branches/X/extend/foo.c`) → resolved against the repository root
  - In particular, the **"Changed paths" output of `svn log -v`** (in the `/branches/...` form) can be passed straight into the `path` of `svn_diff` / `svn_cat`. No prefix stripping is needed
  - Keep this in mind especially in repositories where `svn_describe` reports `repo_url_is_deep: true`
- **Read-only**: commit, update, and delete are not possible. If the user asks for a write, reply that "svn-mcp is read-only".
- **Raw svn output is returned**: the tools return the stdout of `svn` as text, unmodified. Parsing and formatting is your (the LLM's) job.
- **Be token-conscious**: output tends to balloon on large repositories. Start narrow and widen as needed.

### Choosing a tool

| What you want to do | Tool to use |
|---|---|
| **Get an overview of the repository (call first)** | **`svn_describe`** |
| Get the HEAD revision number | `svn_info` (lighter than `svn_log limit:1`) |
| Change history of a path | `svn_log` with `path`, `limit: 10–30`, `verbose: true` |
| **"Which commit fixed ticket #1234?"** | `svn_log({ message_contains: "#1234" })` (substring match on # numbers or any keyword) |
| **Find commits around the date a ticket was filed** | `svn_log({ from_date: "2026-04-10", to_date: "2026-04-20" })` |
| Full diff of a specific revision | `svn_diff` with `change_rev` |
| Diff of a specific revision × a specific file | `svn_diff` with `change_rev` + `path` |
| **"When and by whom was this bug introduced?" "Why is this line like this?"** | **`svn_blame`** (last-modified revision and author per line) |
| File listing (existence check, etc.) | `svn_list` |
| **"Where is foo.cpp?" "Files under src/external" "Normalize an externally-sourced path"** | **`find_path`** (fast when a WC is available. Substring match on any part of the path. Vastly faster than `svn_list -R`) |
| **"Where is do_login called?" "Which code emits this error message?"** | **`grep_in_repo`** (fast when a WC is available. Binaries skipped automatically) |
| File contents at a specific revision | `svn_cat` |
| Show a human the diff visually | `show_diff_external` (only when the user explicitly says they want to see it with their own eyes) |
| Let a human review the log in TortoiseSVN | `show_log_tortoise` (when the user asks to "see it in TortoiseSVN", "check it myself", etc.) |
| Open the file / folder in Windows Explorer | `open_in_explorer` (when the user asks to "open it in Explorer", "open the folder", "show me where the file is", etc.) |

### Common patterns

#### Preparation at session start

```
1. svn_describe()   // Learn the repository URL, HEAD, top_level, and available tools
2. (Build paths from that information from here on)
```

#### Normalize externally-sourced paths with find_path before using them (**important**)

Path strings that appear in ticket bodies, documents, or conversation have unreliable formatting:

- They may **carry a repository or project name as a prefix**, e.g. `XYZ/my-repo/extend/foo.cpp`
- They may be written as UNC or absolute paths such as `\\server\share\...\foo.cpp`
- The directory depth written may not match the WC layout

Passing them as-is to the `path` argument of `svn_log` / `svn_diff` produces a doubled URL or a non-existent path, and fails.

**Fix**: use `find_path` to locate the correct path in the WC, then pass that to subsequent SVN operations. **You do not need to reduce it to the basename** — `find_path` matches on **any substring of the path**, so pass the input as-is:

```
Input pattern → find_path behavior

"foo.cpp"                              → matches every path containing foo.cpp
"src/external/foo.cpp"                 → matches paths containing this sub-path
"XYZ/my-repo/src/external/foo.cpp"     → if the trailing "src/external/foo.cpp" matches, you get the full WC path
"\\server\share\src\foo.c"             → `\` is normalized automatically; matches on basename / trailing part
"extend/"                              → everything under the extend folder
```

**Workflow**:

```
1. Pass the externally-sourced path (e.g. "XYZ/my-repo/extend/foo.cpp") to find_path as-is
2. find_path({ pattern: "XYZ/my-repo/extend/foo.cpp" })
   → matches: [{ path: "trunk/src/extend/foo.cpp" }, ...]
3. One hit → done. Multiple hits → narrow to one using context (branch, folder hierarchy), or ask the user
4. Use the confirmed WC-relative path: svn_log({ path: "trunk/src/extend/foo.cpp", ... })
```

If there is no hit (or too many), **retry with a shorter / longer pattern**:

- 0 hits → shorten the pattern (reduce to `"extend/foo.cpp"` or `"foo.cpp"`)
- Too many → lengthen the pattern (add folder levels) or narrow with `base`

Benefits:
- Independent of the path string's format (with or without prefix, separator style) → fundamentally avoids doubled URLs
- Multiple hits make **different branches / same name in different places** visible
- "Not found in WC" immediately tells you "the WC is stale / it is on another branch / typo"

**Fallback** (when no WC is configured and find_path is unavailable):

- If the path starts with `/`, pass it like `svn_log({ path: "/branches/.../foo.cpp" })` and it is resolved from the repository root (automatic)
- Otherwise pass the path string as relative to `SVN_REPO_URL`
- If that fails, check `repo_url_is_deep` via `svn_describe`, strip the prefix by hand, and retry

#### Investigate recent changes to a file

```
1. svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })
2. When an interesting revision turns up: svn_diff({ change_rev: N, path: "trunk/src/foo.cpp" })
3. If needed, svn_cat({ revision: N, path: "..." }) to inspect the state before / after
```

#### Identify the commit that fixed a ticket (core of ticketing-tool integration)

```
1. (Via the ticketing tool's MCP) fetch the target file(s) and a date field (review date, etc.) for ticket #1234
   - Field names are environment-specific. First confirm the real field names with a metadata tool (describe_schema or similar)
2. Normalize the target file's path string with find_path (see "Normalize externally-sourced paths with find_path" above)
   → yields a confirmed WC-relative path (e.g. "trunk/src/extend/foo.cpp")
3. svn_log({ message_contains: "#1234" })  ← one shot if the # number is in the message
4. If no hit, narrow by a date range around the reference date:
   svn_log({
     path: "<normalized path>",
     from_date: "<reference date -14 days>",   // e.g. reference date 2026-04-15 → 2026-04-01
     to_date:   "<reference date +3 days>",    // e.g. 2026-04-18
     verbose: true
   })
5. Inspect candidate commits with svn_diff({ change_rev: N })
6. Verify consistency of related code with grep_in_repo
```

**Tips for the date window:**

- Commits are usually made **before the review date** (implement first, then submit for review) → make the window **wide in the backward direction**
- Post-review fixes are also possible → extend a few days forward too
- Standard window: reference date −14 days to +3 days. For long-running work, −30 days to +7 days
- If there are too many candidates, combine with a `message_contains` keyword (picked from the ticket subject)

#### Summarize the contents of a whole commit

```
1. svn_log({ from_rev: N, to_rev: "HEAD", verbose: true }) for an overview of changed files
2. If there are few files: svn_diff({ change_rev: N }) for the full diff
3. If there are many files: svn_diff({ change_rev: N, path: "..." }) for only the important ones
```

#### Root-cause a bug (identify the responsible revision)

```
1. svn_blame({ path: "trunk/src/foo.cpp" }) to find the last-modified revision X of the problematic line
2. svn_log({ from_rev: X, to_rev: X, verbose: true }) to see what that commit did
3. svn_diff({ change_rev: X, path: "..." }) for the concrete change
4. If needed, compare whole files before / after with svn_cat
```

### Things not to do

- **Do not use `svn_cat` on binary files** — the output is read as UTF-8 and becomes garbage. Leave `.png` `.exe` `.zip` etc. alone
- **Do not reach for `svn_list({ recursive: true })` right away** — on large repositories it returns thousands of files. **Prefer `find_path` if a WC exists** (fast, low-token). Use svn_list only when there is no WC or you need to guess paths
- **Beware that `grep_in_repo` results may be stale** — it is WC-based, so recent changes are missed if `svn update` has not been run. For important decisions, confirm recent commits with `svn_log`
- **Do not use `svn_diff` without `path` on large commits** — refactoring commits and the like can return thousands of lines. Narrow with `path` whenever possible
- **Do not call the GUI-launching tools (`show_diff_external` / `show_log_tortoise` / `open_in_explorer`) on your own initiative** — they pop up windows, so only on the user's explicit request. Rules of thumb:
  - "Show me the diff" → `svn_diff` (text)
  - "Open it in WinMerge", "I want to check the diff visually" → `show_diff_external`
  - "I want to see it in TortoiseSVN", "like right-clicking to check" → `show_log_tortoise`
  - "Open it in Explorer", "open the folder", "show me where the file is" → `open_in_explorer`

### Handling errors

The first two entries quote the actual error text emitted by the server (currently in Japanese), with an English gloss.

- `svn-mcp は読み取り専用です。サブコマンド 'X' は許可されていません` (svn-mcp is read-only; subcommand 'X' is not allowed) → you requested a write operation. Consider whether a read can substitute
- `svn コマンドが Nms でタイムアウトしました` (svn command timed out after N ms) → reduce `limit`, narrow with `path`, drop `recursive`
- `URL '...' non-existent in revision N` → path or revision is misspelled. Confirm existence with `svn_info` / `svn_list`
- **`svn: E160013: Diff target '...' was not found in the repository at revisions 'A' and 'B'`** → the target file did not exist in the given revision range. **Do not blindly retry**; first identify **the revisions in which that file was touched** with `svn_log({ path: "<target>", verbose: true })`, then rerun `svn_diff` over that range. The file may not have been added yet, or may already have been deleted
- Zod errors such as `Invalid input: Expected number, received string` → pass revisions as integers (e.g. `12856`) or `"HEAD"`. A digits-only string like `"12856"` is converted automatically, but tag names like `"v1.0"` are not accepted

---

## Where to add environment-specific information (in the real file)

Examples of things worth adding to the real file (`copilot-instructions.md` / `CLAUDE.md`):

- Branch naming conventions (`trunk` / `branches/release-X.Y` etc.)
- Aliases for frequently touched paths
- Rules linking ticket numbers to commit messages
- How to divide work with other related MCP servers (e.g. the ticketing tool's MCP)

Keep this template itself generic (do not write environment-specific information here).
