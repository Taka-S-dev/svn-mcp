# 設計書 / アーキテクチャ（svn-mcp）

> このプロジェクトのコードを修正する前に、まずこのドキュメントを読むこと。
> 全体構成・設計思想・拡張方法・注意点をまとめてある。
> ツールごとの引数仕様は [TOOLS.md](TOOLS.md)、利用者向けの導入は [../README.md](../README.md)。

---

## 1. これは何か

SVN リポジトリの **読み取り系コマンド**（log / list / cat / diff / info）を MCP（Model Context Protocol）ツールとして公開するサーバー。AI エージェント（GitHub Copilot CLI / Claude Code 等）から SVN のコミット履歴・ファイル内容・差分を読めるようにする。

- 言語: TypeScript（ESM、Node.js 22+）
- 依存: `@modelcontextprotocol/sdk` と `zod` のみ
- svn 実行: `node:child_process` の `spawn`（Docker 経由 / ホスト直接 の 2 モード）
- 外部 GUI 起動: WinMerge 等を spawn（detached）

## 2. 設計思想（修正時もこれを守る）

| 原則 | 理由 | 修正時の含意 |
|---|---|---|
| **読み取り専用** | AI に誤更新させない安全策 | `SvnClient.execSvn` の `READ_ONLY_SUBCOMMANDS` allowlist に無いサブコマンドは実行不可。commit/delete/copy/move/import/add/revert/update/merge/lock/propset/mucc 等を意図的に除外。新ツール追加時もここを起点に判断する |
| **依存最小** | サプライチェーンリスク低減 | 新しい npm パッケージ追加は慎重に。標準 API で済むなら使わない |
| **Docker / 直接 の両対応** | ホストに svn が無い環境でも動かす | `useDocker=true` のとき `docker compose exec -T <service> svn ...` で実行。`composeDir` を CWD として spawn |
| **ツール説明文＝ LLM の取扱説明書** | LLM は description を読んで使い方を判断する | description は丁寧に書く。挙動を変えたら description も必ず更新 |
| **エラーは構造化** | LLM が自己訂正できるように | `SvnError` に `code` / `stderr` / `stdout` を載せて返す。テキストには「何が原因か」を書く |
| **GUI 起動は detached** | MCP サーバはすぐ応答を返したい | `showDiffExternal` は `spawn(... { detached: true, stdio: "ignore" })` + `child.unref()`。終了を待たない |

## 3. 全体構成

```
src/
├── index.ts              エントリポイント。.env 読込 → SvnClient 生成 → ツール登録 → MCP 起動
├── svn/
│   └── client.ts         svn コマンド実行ラッパー（spawn・read-only allowlist・Docker/直接切替・タイムアウト）
├── external/
│   ├── diff-tool.ts      外部差分ツール（WinMerge 等）の起動（一時ファイル展開＋detached spawn）
│   ├── tortoise.ts       TortoiseProc.exe の起動（detached spawn）
│   └── explorer.ts       Windows エクスプローラの起動（detached spawn・fs.statSync でファイル/フォルダ判定）
└── tools/
    ├── context.ts             ツール共通基盤（ToolContext / textResult / jsonResult / errorResult / runSvn）
    ├── svn-describe.ts        セッション開始時に呼ぶ「自己紹介」ツール（info + list + ツール可用性）
    ├── svn-info.ts            svn info
    ├── svn-list.ts            svn list
    ├── svn-log.ts             svn log
    ├── svn-cat.ts             svn cat
    ├── svn-diff.ts            svn diff
    ├── show-diff-external.ts  外部GUI（WinMerge 等）で差分表示
    ├── show-log-tortoise.ts   TortoiseSVN のログダイアログを開く
    └── open-in-explorer.ts    Windows エクスプローラで開く
```

### レイヤー構造

```
MCP クライアント（Copilot CLI / Claude Code）
        ↓ MCP プロトコル（stdio）
index.ts（登録された各ツール）
        ↓
tools/*.ts（引数バリデーション・整形）
        ↓ ToolContext 経由
svn/client.ts（svn コマンド実行）           external/diff-tool.ts（GUI 起動）
        ↓                                          ↓
   docker compose exec / 直接 svn                WinMerge 等
        ↓
   SVN リポジトリ（file:// or https://）
```

## 4. リクエストのライフサイクル

`svn_log` を例に：

1. LLM が `svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })` を呼ぶ
2. `index.ts` が登録したハンドラが起動、zod が引数を検証
3. ハンドラが `ctx.svn.log(path, { limit, verbose, ... })` を呼ぶ
4. `SvnClient.log()` が `svn log --limit 10 -v <repoUrl>/trunk/src/foo.cpp` の引数列を作る
5. `SvnClient.execSvn()` が allowlist を通過させ、`buildCommand()` で Docker / 直接 を選択
6. `spawnAsync()` で実プロセス起動、stdout / stderr を収集、timeout で kill
7. 0 終了なら stdout を返し、非0 終了なら `SvnError` を投げる
8. ハンドラが `textResult(stdout)` で MCP レスポンス化、`SvnError` は `errorResult(message, detail)` で返す

## 5. モジュール責務

### `index.ts`
- `.env` から設定読込（`SVN_REPO_URL` / `SVN_USE_DOCKER` / `SVN_COMPOSE_DIR` / `SVN_DOCKER_SERVICE` / `SVN_TIMEOUT_MS` / `SVN_EXTERNAL_DIFF_TOOL`）
- 設定不整合は起動時に throw（`SVN_REPO_URL` 未設定、`SVN_USE_DOCKER=true` なのに `SVN_COMPOSE_DIR` 無し、等）
- `SvnClient` と `DiffToolConfig` を生成し `ToolContext` を組む
- 各ツールの `register(server, ctx)` を呼ぶ
- **ツールを増やしたらここに import と register 呼び出しを足す**

### `svn/client.ts`
- **READ_ONLY_SUBCOMMANDS allowlist**: `info` / `list` / `ls` / `log` / `cat` / `diff` / `blame` / `praise` / `annotate` / `stat` / `status` / `help` / `--version` のみ通過。それ以外は `SvnError` で即拒否。`execSvn()` の冒頭でチェックされる
- **Docker / 直接 切替** (`buildCommand`): `useDocker=true` なら `docker compose exec -T <service> svn ...`、`composeDir` を CWD に。`useDocker=false` ならホストの `svn` を直接 spawn
- **タイムアウト** (`spawnAsync`): `timeoutMs` 経過で `child.kill()`、エラーに「タイムアウトしました」と明記
- 高レベル API（`info` / `list` / `log` / `cat` / `diff`）。引数を `svn` の CLI 引数に組み立てるだけのシン層
- `resolveUrl(path)`: 末尾スラッシュ・先頭スラッシュを正規化し、`repoUrl/<path>` を作る
- 全メソッドは **svn の生の stdout 文字列をそのまま返す**（パースしない。LLM はテキストとして読める）

### `external/diff-tool.ts`
- `showDiffExternal(svn, config, args)`:
  1. `svn.cat(revisionBefore, path)` と `svn.cat(revisionAfter, path)` で 2 リビジョンの内容を取得
  2. `os.tmpdir() + svn-mcp-diff-XXXX/` に左右ファイルを書き出し（`r<rev>_<basename>` 命名）
  3. `spawn(toolPath, [leftFile, rightFile], { detached: true, stdio: "ignore" })` で GUI 起動
  4. `child.unref()` でツール終了を待たずに `{ leftFile, rightFile, tool, pid }` を返す
- **MCP サーバはホスト OS（Windows/macOS）で動かす必要がある**（Docker 内では GUI が出ない）

### `external/tortoise.ts`
- `showLogInTortoise(config, fallbackBaseUrl, args)`:
  1. `config.clientRepoBase`（未設定なら `fallbackBaseUrl` = `SvnConfig.repoUrl`）と `args.path` を連結してターゲットパスを作る
  2. `spawn(procPath, ["/command:log", "/path:<target>", "/closeonend:0"], { detached: true })` で TortoiseProc.exe 起動
  3. `child.unref()` でツール終了を待たずに `{ tool, pid, targetPath }` を返す
- **Windows ホスト前提**。`SVN_REPO_URL` が Docker 内 `file://` のように Windows から見えない場合は、`SVN_REPO_URL_CLIENT` で Windows 到達可能な URL/作業コピーを別途指定する

### `external/explorer.ts`
- `openInExplorer(config, args)`:
  1. `config.workingCopyPath` と `args.path` を `path.join` で連結
  2. `fs.statSync(target, { throwIfNoEntry: false })` でファイル／フォルダ判定
  3. ファイルなら `spawn("explorer.exe", ["/select,<target>"])`、フォルダなら `spawn("explorer.exe", ["<target>"])`
  4. `detached: true` + `child.unref()` で即時応答
- **Windows 専用**。`SVN_WORKING_COPY` を `SVN_REPO_URL_CLIENT`（Tortoise 用）と分けているのは、Tortoise が URL も受け付けるのに対し Explorer はローカルパス専用だから

### `tools/context.ts`（共通基盤）
- `ToolContext` 型: `{ svn: SvnClient; diffTool?: DiffToolConfig }`
- `ToolResult` 型と 3 つのヘルパー:
  - `textResult(text)` — プレーンテキスト応答
  - `jsonResult(data)` — JSON.stringify した応答（`show_diff_external` で使用）
  - `errorResult(message, detail?)` — `isError: true` 付き応答

### `tools/*.ts`（各ツール）
- 1 ファイル 1 ツール
- `register(server: McpServer, ctx: ToolContext)` をエクスポート
- 中で `server.registerTool(name, { title, description, inputSchema }, handler)` を呼ぶ
- `SvnError` を `errorResult` で包む共通パターン

## 6. ツールの実装パターン

全ツールが同じ形：

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SvnError } from "../svn/client.js";
import { textResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  someArg: z.string().optional().describe("引数の説明（LLM が読む）"),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "tool_name",
    {
      title: "人間向けの短い名前",
      description: "LLM 向けの詳しい説明。いつ・どう使うかを書く。",
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

## 7. 重要な仕組み

### 読み取り専用の保証

破壊的サブコマンドが LLM の生成ミスやプロンプトインジェクションで紛れ込んでも実行されないよう、`SvnClient.execSvn()` 入口で `READ_ONLY_SUBCOMMANDS` allowlist と照合する。新しいツールを追加する場合は、ここに必要なサブコマンドがあるか確認すること（無ければ allowlist を**広げるのではなく**、本当に読み取り系か検討する）。

### Docker モード

`useDocker=true` のとき、`docker compose exec -T <service> svn ...` 形式で実行する：
- `-T` は TTY 割り当てなし（spawn から動かすときに必要）
- `cwd` を `composeDir` に設定して `docker compose` がそのディレクトリの compose ファイルを参照する
- サービス内に **svn コマンドが入っている**必要がある（無ければ Dockerfile に `apt-get install -y subversion` 等を追加）

### 外部差分ツール起動の制約

- ホスト OS で MCP サーバを動かしていないと GUI は出ない（Docker 内で起動した GUI はユーザーから見えない）
- `SVN_EXTERNAL_DIFF_TOOL` 未設定なら `show_diff_external` ツールは登録されるが、呼び出すと「未設定です」のエラーを返す（他のツールは普通に動く）
- 一時ファイルは `os.tmpdir()` に作られ、OS のクリーンアップに任せる（明示的削除はしない。WinMerge 等が掴んでいる間に消すと不具合になるため）

### `svn diff` の指定方法

3 通りある:
- **`changeRev` のみ**: 単一リビジョンの差分（`svn diff -c REV`）
- **`fromRev` + `toRev`**: 範囲の差分（`svn diff -r FROM:TO`）
- 両方無指定: working copy の差分（Docker 経由・URL 指定の運用では普通使わない）

ツール側（`tools/svn-diff.ts`）で「`change_rev` か `from_rev`+`to_rev` のどちらか必須」をランタイムでバリデーションしている（zod だけでは表現しきれない条件）。

## 8. 拡張方法

### 新しい読み取り系ツールを追加する

例: `svn_blame` を追加したい場合

1. `src/svn/client.ts` の `SvnClient` に `blame(rev, path)` メソッドを追加（`READ_ONLY_SUBCOMMANDS` には `blame` が既にある）
2. `src/tools/svn-blame.ts` を作成（`svn-info.ts` を雛形にすると最短）
3. `register(server, ctx)` をエクスポート
4. `src/index.ts` に import と `register()` 呼び出しを追加
5. `docs/TOOLS.md` に仕様を追記
6. `npm run build`

### 書き込み系を追加したくなったら（注意）

設計上、書き込み系は実装しないことになっている（「AI に誤更新させない」）。どうしても必要な場合は：

- `READ_ONLY_SUBCOMMANDS` の名前と思想を変更することになる → コードの安全境界がなくなる
- 別バイナリ（`svn-mcp-write` 等）として完全に分離する方が安全
- 認証情報の扱い（commit には credential が要る）が増える

### Docker サービス名を可変にしたい

現状 `SVN_DOCKER_SERVICE` で 1 サービス固定。複数リポを別サービスで管理するなら、ツール引数に `service` を追加して `SvnClient` に渡す API 変更が要る（現状はそこまでの需要がないので未対応）。

## 9. 変更時の注意点（ハマりどころ）

- **description を更新し忘れない**：挙動を変えたらツールの `description` も直す。LLM はそれを読んで動くので、ズレると誤動作する。
- **`READ_ONLY_SUBCOMMANDS` を緩めない**：新しいサブコマンドを追加するときは「これは本当に副作用がないか？」を確認する。`update` / `revert` / `merge` 等はワーキングコピーを変える。
- **Docker モードの cwd**：`SVN_COMPOSE_DIR` が無いと `docker compose` がエラー。`useDocker=true` のときは必須。
- **タイムアウト**：`SVN_TIMEOUT_MS` 既定 30 秒。大きなリポジトリの `svn list -R` や長い `svn log` ではこれが効くので、必要なら `.env` で延ばす。
- **GUI ツール起動はホスト OS で**：MCP サーバを WSL や Docker で動かしていると WinMerge は起動するが、Windows 側に表示されない。
- **stdout は UTF-8 として読む**：バイナリファイルを `svn_cat` で取ると文字化けする。`svn_cat` の description にも警告あり。バイナリ判定機能は持っていない（呼ぶ側が拡張子等で判断する）。
- **個人情報を書かない**：git 追跡されるファイル（src・docs・README・`.env.example`）に実フォルダパス・実リポ名・実ホスト名を書かない。`.env`（追跡対象外）に閉じ込める。

## 10. 動作確認

```bash
npm run build         # ビルド（tsc）
npm run typecheck     # 型チェックのみ

# 実 SVN に対する疎通テスト（.env が必要）
npm run dev           # tsx で起動、stdin/stdout で MCP プロトコル待機
```

`npm run dev` で起動すると stderr に `[svn-mcp] started (repo=..., docker=...)` が出る。`SVN_EXTERNAL_DIFF_TOOL` 未設定なら `show_diff_external は利用不可` の警告も出る。

## 11. 制約

- **読み取り専用**: 設計上の意図。書き込み API は実装しない
- **Docker モード**: `docker compose` v2 を想定。`docker-compose`（v1）には未対応
- **GUI 起動**: MCP サーバがホスト OS で動いている必要あり（Docker / WSL2 内では別途設定要）
- **UTF-8 前提**: `svn cat` の出力は UTF-8 として読む。バイナリ・他エンコーディングのファイルは扱えない
