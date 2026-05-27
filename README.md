# svn-mcp

SVN リポジトリへの**読み取りアクセス**を提供する MCP（Model Context Protocol）サーバ。
AI エージェント（GitHub Copilot CLI / Claude Code 等）から SVN のコミット履歴・ファイル内容・差分を読めるようにする。

## 何ができるか

- 「trunk/src/foo.cpp の最近 10 件のコミット履歴を見せて」
- 「r142 の変更内容を foo.cpp に絞って unified diff で」
- 「r141 → r142 の差分を WinMerge で開いて目視確認したい」
- 「あるパスを変更したコミットの中から特定のキーワードを含むものを探したい」

## 設計方針

- **読み取り専用**: `info` / `list` / `log` / `cat` / `diff` のみ。コミット系は実装しない（AI に誤更新させない安全策）
- **Docker と直接の両対応**: ホストに `svn` が無くても、Docker コンテナ内の svn を `docker compose exec` 経由で動かせる
- **GUI 差分ツール起動**: LLM が推定した修正候補を、人間が WinMerge 等で目視確認できる
- **依存最小**: `@modelcontextprotocol/sdk` と `zod` のみ

## セットアップ手順（クリーン環境から）

### 0. 必要環境

- **Node.js 22 以上**（22 LTS または 24 LTS 推奨）
  - 確認: `node --version`
  - 未インストールなら https://nodejs.org/ から
- **svn コマンド**（`SVN_USE_DOCKER=false` で使う場合のみ。Docker 経由なら不要）
- **Docker / Docker Compose v2**（`SVN_USE_DOCKER=true` で使う場合のみ）
- Git（コード取得に使う場合）

### 1. コードを取得

git を使う場合：
```powershell
git clone <このリポジトリ URL> svn-mcp
cd svn-mcp
```

zip / USB でコピーした場合は、解凍後そのディレクトリに `cd`。

### 2. 依存インストール

```powershell
npm install
```

`added N packages, found 0 vulnerabilities` のような出力が出れば OK。

### 3. ビルド

```powershell
npm run build
```

`dist/` ディレクトリが生成される。

### 4. `.env` を作成

PowerShell:
```powershell
Copy-Item .env.example .env
```

Git Bash / WSL:
```bash
cp .env.example .env
```

`.env` をエディタで開いて編集。必要項目は次の節を参照。

#### 最小構成 ① — Docker 経由（ホストに svn 不要）

`docker compose` で立てたコンテナの中の `svn` を使うパターン。

```dotenv
SVN_REPO_URL=file:///svn-repo/my-repo
SVN_USE_DOCKER=true
SVN_COMPOSE_DIR=C:\path\to\your\docker-compose-dir
# SVN_DOCKER_SERVICE=svn        # 既定 "svn"。compose のサービス名に合わせる
```

`SVN_COMPOSE_DIR` は `compose.yml` のあるディレクトリ。`SVN_REPO_URL` はコンテナ内から見たパス。

#### 最小構成 ② — ホストの svn を直接

ホストに `svn` がインストール済みなら：

```dotenv
SVN_REPO_URL=https://svn.example.com/repo
SVN_USE_DOCKER=false
```

#### オプション — WinMerge で差分を目視確認したい場合

```dotenv
SVN_EXTERNAL_DIFF_TOOL=C:\Program Files\WinMerge\WinMergeU.exe
```

未設定だと `show_diff_external` ツールだけが無効になり、他のツール（`svn_log` 等）は動く。
このツールを使うときは **MCP サーバをホスト OS（Windows/macOS）で動かすこと**（Docker / WSL 内では GUI が表示されない）。

#### オプション — TortoiseSVN でログを目視確認したい場合

```dotenv
SVN_TORTOISE_PROC=C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe
# Docker 内 file:// 等で SVN_REPO_URL が Windows から見えない場合は、
# TortoiseSVN 用のベース URL or 作業コピーパスを別途指定:
#SVN_REPO_URL_CLIENT=https://svn.example.com/repo
```

未設定だと `show_log_tortoise` ツールだけが無効になり、他のツールは動く。
Windows ホストで MCP サーバを動かしている必要がある。

#### オプション — Windows エクスプローラで開きたい場合

```dotenv
SVN_WORKING_COPY=C:\path\to\working-copy
```

未設定だと `open_in_explorer` ツールだけが無効になる。
作業コピー（ローカル WC）が前提で、SVN リポジトリ URL とは別物。

#### オプション — タイムアウト

```dotenv
SVN_TIMEOUT_MS=60000    # 既定 30000ms。大きなリポジトリで svn log/list が遅いとき延長
```

### 5. 動作確認

#### 簡易（起動だけ）

```powershell
npm run dev
```

stderr に以下のような行が出れば OK（stdin/stdout で MCP プロトコル待機。Ctrl+C で停止）：

```
[svn-mcp] started (repo=file:///svn-repo/my-repo, docker=true)
```

#### 推奨（疎通テスト）

```powershell
npm run build
npm run smoke
```

MCP プロトコル経由で主要ツール（svn_describe / svn_info / svn_list / svn_log / find_path）を実際に呼び、PASS/FAIL を表示します。
SVN サーバへの実接続まで含めた end-to-end 確認になるので、最初のセットアップやリファクタ後の確認に。

`SVN_EXTERNAL_DIFF_TOOL` 未設定の場合は追加で次の行も出る：
```
[svn-mcp] SVN_EXTERNAL_DIFF_TOOL 未設定: show_diff_external は利用不可
```

これは警告で、他のツールは普通に動く。

接続できない場合は[トラブルシューティング](#トラブルシューティング)参照。

### 6. MCP クライアントへ登録

次の「[MCP クライアントへの登録](#mcp-クライアントへの登録)」セクション参照。

## MCP クライアントへの登録

このプロジェクトには **`.mcp.json` が同梱されている**ので、ほとんどの MCP クライアントは**プロジェクトディレクトリで起動するだけ**で svn MCP を自動認識します。

### Claude Code

#### 方法 ①（推奨）: `.mcp.json` 自動認識

VSCode を **このプロジェクトのフォルダで開く**だけ。Claude Code 拡張が `.mcp.json` を検出し、初回起動時に承認ダイアログが出るので Approve。

承認後の確認は、新しい会話で：

```
使える MCP ツール一覧を見せて
```

#### 方法 ②: ユーザー設定（どこのプロジェクトからでも使いたい場合）

`~/.claude/settings.json` の `mcpServers` キーに追記：

```json
{
  "mcpServers": {
    "svn": {
      "command": "node",
      "args": ["--env-file=.env", "<このプロジェクトの絶対パス>/dist/index.js"],
      "cwd": "<このプロジェクトの絶対パス>"
    }
  }
}
```

VSCode を再起動。

> パスは Windows でも JSON 内では `/` 区切り推奨（`\` だとエスケープが面倒）。

### GitHub Copilot CLI

#### 方法 ①（推奨）: `.mcp.json` 自動認識

このプロジェクトディレクトリで `copilot` を起動するだけ：

```powershell
cd C:\path\to\svn-mcp
copilot
```

`.mcp.json` がワークスペース設定として自動読み込みされる。確認：

```powershell
copilot mcp list
# → Workspace servers: svn (local) と出ればOK
```

#### 方法 ②: ユーザー設定（どこからでも使いたい場合）

```powershell
copilot mcp add svn `
  --env SVN_REPO_URL=file:///svn-repo/my-repo `
  --env SVN_USE_DOCKER=true `
  --env SVN_COMPOSE_DIR=C:\path\to\your\docker-compose-dir `
  -- node <このプロジェクトの絶対パス>/dist/index.js
```

> ユーザー設定だと `--env-file=.env` の相対パス解決が効かないので、`--env` で直接環境変数を渡す。

### 複数の MCP サーバを併用する場合

他の MCP サーバ（チケット管理ツール用など）と一緒に使うときは、**両方を指す `.mcp.json` を 1 つ別ディレクトリに作る**のが手っ取り早い：

```powershell
mkdir C:\path\to\mcp-workspace
# 下記の .mcp.json をその中に置く
cd C:\path\to\mcp-workspace
copilot         # または VSCode をそのフォルダで開く
```

`C:\path\to\mcp-workspace\.mcp.json`：

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

ポイント：

- **`cwd` を必ず指定する** — これで各 MCP サーバが「**自分のプロジェクトディレクトリで起動**」する。`--env-file=.env` も `dist/index.js` もそのディレクトリで相対解決されるので、各サーバが各自の `.env` を読む
- パス区切りは `/` 推奨（`\` だと JSON エスケープが面倒）
- ワークスペース用ディレクトリは空でも OK（`.mcp.json` だけあればよい）
- 確認は `copilot mcp list` または Claude Code で `使える MCP ツール一覧を見せて`

### 共通の注意

- `.mcp.json` 方式の場合、**MCP クライアントを起動した CWD がプロジェクトディレクトリ**であることが必要
- `.env` の値を変えたら、クライアントを再起動して MCP サーバープロセスを再生成すること（プロセス起動時にしか `.env` は読まれない）

## 提供ツール

| ツール | 用途 |
|---|---|
| `svn_describe` | リポジトリの URL・HEAD・トップレベル構造・利用可能ツール・WC 最新性を一括取得（**セッション開始時にまず呼ぶ**） |
| `svn_info` | リポジトリ/パスの info（HEAD revision など） |
| `svn_list` | ファイル/ディレクトリ一覧（`-R` で再帰） |
| `svn_log` | コミット履歴（path/limit/range/verbose 指定可） |
| `svn_cat` | 指定リビジョンのファイル内容を取得 |
| `svn_diff` | 単一リビジョン or 範囲の unified diff |
| `svn_blame` | 行ごとに「最後に変更したリビジョン・著者」を表示（バグ調査の起点） |
| `find_path` | WC 内のファイル名を高速検索（`SVN_WORKING_COPY` 設定時） |
| `grep_in_repo` | WC 内のテキストファイルを grep（`SVN_WORKING_COPY` 設定時） |
| `show_diff_external` | 2 リビジョン × ファイルを WinMerge 等で開く（人間向け） |
| `show_log_tortoise` | 指定パスのログダイアログを TortoiseSVN で開く（人間向け） |
| `open_in_explorer` | 作業コピー配下のパスを Windows エクスプローラで開く（人間向け） |

**詳細な仕様（引数・返却値・サンプルクエリ）は [docs/TOOLS.md](docs/TOOLS.md) 参照。**

## ツール追加方法

1. `src/svn/client.ts` の `SvnClient` に対応メソッドを追加（read-only allowlist 通過確認）
2. `src/tools/your-tool.ts` を新規作成
3. `register(server, ctx)` 関数をエクスポート
4. `src/index.ts` に `import` と `register` 呼び出しを追加

既存ツールがテンプレートとして使えます。`src/tools/svn-info.ts` が一番シンプル。

**コードを修正・拡張する場合は、まず [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（設計書）を読んでください。** 全体構成・設計思想・拡張手順・注意点がまとまっています。

## 想定ワークフロー

典型的な使い方の流れ：

1. ユーザ: 「foo.cpp の最近の修正を見たい」
2. LLM → svn-mcp: `svn_log(path="trunk/src/foo.cpp", limit=10, verbose=true)` で履歴取得
3. LLM → svn-mcp: 候補ごとに `svn_diff(change_rev=N, path=...)` で差分確認
4. LLM がハンク単位で内容を要約し、「r142 で X が変わった」等を提示
5. ユーザ: 「目で見たい」
6. LLM → svn-mcp: `show_diff_external(revision_before=141, revision_after=142, path=...)` → WinMerge 起動

外部のチケット管理ツール用 MCP サーバと併用すれば、「チケットに書かれたファイルパス → SVN で履歴と差分を確認」という流れも自然言語の指示でつながります。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `SVN_REPO_URL が設定されていません` | `.env` を作成・編集 |
| `SVN_USE_DOCKER=true のとき SVN_COMPOSE_DIR の指定が必要です` | `.env` に `SVN_COMPOSE_DIR=...` を追加 |
| `svn: E170000: URL '...' non-existent in revision N` | `SVN_REPO_URL` が間違っているか、指定パスが存在しない。`svn_info` で確認 |
| `svn コマンドが Nms でタイムアウトしました` | `SVN_TIMEOUT_MS` を増やすか、`recursive` を外す／`limit` を減らす |
| `svn-mcp は読み取り専用です。サブコマンド '...' は許可されていません` | 設計通り。書き込み系は別ツールでやる |
| `docker compose exec` が動かない | `SVN_COMPOSE_DIR` が compose.yml のあるディレクトリか確認。`docker compose -f <そこ>/compose.yml ps` で疎通確認 |
| Docker コンテナに svn が無い | Dockerfile に `apt-get install -y subversion` 等を追加してリビルド |
| `show_diff_external` で「外部差分ツールが未設定」 | `.env` に `SVN_EXTERNAL_DIFF_TOOL=...` を追加 |
| `show_log_tortoise` で「TortoiseSVN が未設定」 | `.env` に `SVN_TORTOISE_PROC=...` を追加 |
| TortoiseSVN が起動するが「URL が見つからない」等のエラー | Docker 内 `file://` URL を Windows TortoiseSVN から見ようとしている。`.env` に `SVN_REPO_URL_CLIENT=...` で Windows 到達可能な URL or 作業コピーパスを指定 |
| `open_in_explorer` で「作業コピーが未設定」 | `.env` に `SVN_WORKING_COPY=...` を追加 |
| エクスプローラは開くがフォルダが存在しない | `SVN_WORKING_COPY` 配下に該当パスが無い。WC を `svn update` するか、別の WC を指す |
| WinMerge / TortoiseSVN / Explorer が起動しない／画面に出ない | MCP サーバを Docker / WSL2 内で動かしていないか確認。Windows ホスト OS で動かす必要あり |
| `svn_cat` の出力が文字化け | バイナリファイルを cat していないか確認。UTF-8 以外のテキストにも未対応 |
| `svn_log -v` の出力が長すぎてトークンが尽きる | `limit` を減らすか、`path` を指定して特定ファイルに絞る |

## アーキテクチャ

```
src/
├── index.ts              MCP サーバ起動・ツール登録・.env 読込
├── svn/
│   └── client.ts         svn コマンド実行ラッパー（read-only allowlist・Docker/直接切替・タイムアウト）
├── external/
│   ├── diff-tool.ts      外部差分ツール起動（一時ファイル展開＋detached spawn）
│   ├── tortoise.ts       TortoiseProc.exe 起動（detached spawn）
│   └── explorer.ts       Windows エクスプローラ起動（detached spawn）
├── wc/
│   └── scanner.ts        作業コピーの walk・バイナリ判定ヘルパー
└── tools/
    ├── context.ts                ツール共通基盤（ToolContext, textResult, jsonResult, errorResult, runSvn）
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

依存は `@modelcontextprotocol/sdk` と `zod` のみ（サプライチェーン最小化）。svn 実行は `node:child_process` の `spawn`、環境変数は `node --env-file`、外部 GUI 起動は detached spawn。

詳しい設計（レイヤー構造・各モジュールの責務・拡張方法・修正時の注意点）は **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** にまとめています。
