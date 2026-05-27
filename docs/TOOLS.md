# svn-mcp ツール仕様

このサーバーが提供する 6 つの MCP ツールの詳細仕様。**ソース** `src/tools/*.ts` **が一次情報**で、このドキュメントは人間向けの要約。仕様変更があったら再生成する。

## 目次

| ツール | 用途 | ソース |
|---|---|---|
| [svn_describe](#svn_describe) | リポジトリ概要（URL・HEAD・top_level・ツール可用性）を一括取得 | [src/tools/svn-describe.ts](../src/tools/svn-describe.ts) |
| [svn_info](#svn_info) | リポジトリ／パスの info（HEAD revision など） | [src/tools/svn-info.ts](../src/tools/svn-info.ts) |
| [svn_list](#svn_list) | ファイル／ディレクトリ一覧 | [src/tools/svn-list.ts](../src/tools/svn-list.ts) |
| [svn_log](#svn_log) | コミット履歴（path/limit/range/verbose） | [src/tools/svn-log.ts](../src/tools/svn-log.ts) |
| [svn_cat](#svn_cat) | 指定リビジョンのファイル内容 | [src/tools/svn-cat.ts](../src/tools/svn-cat.ts) |
| [svn_diff](#svn_diff) | unified diff（単一 or 範囲リビジョン） | [src/tools/svn-diff.ts](../src/tools/svn-diff.ts) |
| [svn_blame](#svn_blame) | 行ごとの最終変更リビジョン・著者 | [src/tools/svn-blame.ts](../src/tools/svn-blame.ts) |
| [find_path](#find_path) | WC 内のファイル名検索（要 SVN_WORKING_COPY） | [src/tools/find-path.ts](../src/tools/find-path.ts) |
| [grep_in_repo](#grep_in_repo) | WC 内のテキスト grep（要 SVN_WORKING_COPY） | [src/tools/grep-in-repo.ts](../src/tools/grep-in-repo.ts) |
| [show_diff_external](#show_diff_external) | 外部 GUI（WinMerge 等）で差分表示 | [src/tools/show-diff-external.ts](../src/tools/show-diff-external.ts) |
| [show_log_tortoise](#show_log_tortoise) | TortoiseSVN のログダイアログを開く | [src/tools/show-log-tortoise.ts](../src/tools/show-log-tortoise.ts) |
| [open_in_explorer](#open_in_explorer) | Windows エクスプローラで開く | [src/tools/open-in-explorer.ts](../src/tools/open-in-explorer.ts) |

---

## 共通の設計方針

- **読み取り専用**: `svn` の読み取り系サブコマンドのみ許可（`SvnClient` の allowlist で保証）。commit / delete / copy / move / import / add / revert / update / merge / lock / propset 等は実行できない
- **生の svn 出力を返す**: 各ツールは `svn` の stdout をテキストとしてそのまま返す。LLM は人間と同じテキストを読む
- **Docker / 直接 両対応**: `.env` の `SVN_USE_DOCKER` で切替（既定 `true`）
- **UTF-8 前提**: `svn_cat` の出力は UTF-8 として扱う。バイナリファイルには使わない

---

## svn_describe

### 何をするか

リポジトリの「自己紹介」を返す。**セッション開始時にまず呼ぶ**ことを想定したツール。
LLM が「どこに何があるか分からない」迷子状態になるのを防ぐ。

内部で `svn info` と `svn list` を 1 回ずつ並列実行し、結果をマージして返す。

### 引数

なし。

### 返却値

```jsonc
{
  "repo_url": "file:///svn-repo/my-repo",
  "docker_mode": true,
  "head_revision": 142,
  "top_level": ["branches/", "tags/", "trunk/"],
  "tools_available": {
    "show_diff_external": true,    // SVN_EXTERNAL_DIFF_TOOL 設定済み
    "show_log_tortoise": false,    // SVN_TORTOISE_PROC 未設定
    "open_in_explorer": true       // SVN_WORKING_COPY 設定済み
  },
  "hint": "trunk / branches / tags の標準レイアウト。ファイル探索は通常 trunk/ 配下から始める。",
  "info_raw": "Path: ...\nURL: ...\nRevision: 142\n..."
}
```

`hint` は `trunk/` `branches/` `tags/` の有無から自動生成する。標準レイアウトなら「trunk/ から探せ」、そうでなければ「top_level を見て構造を判断せよ」。

### よく使うクエリ例

```
セッション開始時の準備
→ svn_describe()
→ 返却内容を元に、以降の svn_log / svn_diff のパスを組み立てる
```

### 注意

- 2 回 svn を叩くので毎回呼ぶと多少コストあり。**セッション開始時の 1 回**で十分
- ツール可用性は MCP サーバ起動時の `.env` で決まる。`.env` を変えたら MCP クライアントを再起動して反映させる必要あり

---

## svn_info

### 何をするか

`svn info` を実行して、リポジトリまたは指定パスのメタ情報（URL・最終リビジョン・最終更新者・最終更新日時など）を返す。

- リポジトリの存在確認
- HEAD リビジョン番号の取得（他ツールで `to_rev` に使う等）
- 「このパスは本当に存在するか」のチェック

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | — | リポジトリルート | リポジトリ内の相対パス（例: `trunk`、`trunk/src/foo.cpp`） |

### 返却値

`svn info` の生の stdout を文字列で返す。例：

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

### よく使うクエリ例

```
リポジトリの HEAD を確認
→ svn_info()                    # Revision: 142

trunk の最終更新者を確認
→ svn_info({ path: "trunk" })

特定ファイルが存在するか確認
→ svn_info({ path: "trunk/src/foo.cpp" })   # 存在しなければ SvnError
```

---

## svn_list

### 何をするか

`svn list`（または `-R` 付きで `svn list -R`）でファイル／ディレクトリ一覧を返す。

- チケットに記載されたファイル名から実パスを探す
- 修正対象ファイルの存在確認
- 再帰的に全ファイル列挙

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | — | リポジトリルート | リポジトリ内の相対パス（例: `trunk/src`） |
| `recursive` | boolean | — | `false` | true で `-R`（再帰）。大規模リポジトリでは出力が膨大になる |

### 返却値

`svn list` の生の stdout。

```
README.md
package.json
src/
src/index.ts
src/tools/
```

`recursive=true` のときはサブディレクトリの中身まで全部出る。

### よく使うクエリ例

```
trunk 直下のディレクトリ／ファイル一覧
→ svn_list({ path: "trunk" })

src 配下を全て列挙（再帰）
→ svn_list({ path: "trunk/src", recursive: true })
```

### 注意

- 大きなリポジトリで `recursive=true` を呼ぶと出力が長大になりトークンを大量消費する。必要なときだけ使う
- 末尾 `/` でディレクトリを表すので、ファイル名だけ抽出したいなら呼び出し側でフィルタする

---

## svn_log

### 何をするか

`svn log` でコミット履歴を返す。

**最も使うツール**。あるパスについて「最近どのコミットで変更されたか」を特定する起点。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | — | リポジトリ全体 | リポジトリ内の相対パス。指定すると、そのパスへの変更履歴のみ |
| `limit` | integer (>0) | — | なし（全件） | 取得コミット数の上限（`--limit N`）。履歴の長いファイルでは 20〜50 程度に絞る |
| `verbose` | boolean | — | `false` | true で各コミットの変更パス一覧（A/M/D）も付与（`-v`） |
| `from_rev` | integer or string | — | — | 範囲指定の開始リビジョン（`to_rev` と併用。日付範囲とは排他） |
| `to_rev` | integer or string | — | — | 範囲指定の終了リビジョン（例: `200` or `"HEAD"`） |
| `from_date` | string (YYYY-MM-DD) | — | — | 日付範囲の開始（`to_date` と併用。リビジョン範囲とは排他） |
| `to_date` | string (YYYY-MM-DD) | — | — | 日付範囲の終了 |
| `message_contains` | string | — | — | コミットメッセージ／著者／変更パスの部分一致検索（`svn log --search`） |

`from_rev` のみ／`to_rev` のみの片方指定でも、不足側はそれぞれ `1` / `HEAD` で補完される（`SvnClient.log` の挙動）。

### 返却値

`svn log` の生の stdout（`-v` 指定ありなら変更パス一覧付き）。

```
------------------------------------------------------------------------
r142 | alice | 2026-05-19 13:26:22 +0900 (Tue, 19 May 2026) | 1 line
Changed paths:
   M /trunk/src/foo.cpp
   A /trunk/src/bar.cpp

リファクタリング: 共通処理を utils へ抽出
------------------------------------------------------------------------
r141 | bob | 2026-05-18 09:11:03 +0900 (Mon, 18 May 2026) | 1 line
...
```

### よく使うクエリ例

```
特定ファイルの最近の変更コミット 10 件
→ svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })

リビジョン範囲（100〜HEAD）の全コミット
→ svn_log({ from_rev: 100, to_rev: "HEAD", verbose: true })

リポジトリ全体の最新 5 件
→ svn_log({ limit: 5 })

チケット番号 #1234 を含むコミットを検索
→ svn_log({ message_contains: "#1234" })

日付範囲で絞り込み（チケット起票日付近）
→ svn_log({ from_date: "2026-04-10", to_date: "2026-04-20", path: "trunk/src" })

組み合わせ: trunk 配下で 4月のlogin関連のコミット
→ svn_log({
    path: "trunk",
    message_contains: "login",
    from_date: "2026-04-01",
    to_date: "2026-04-30"
  })
```

### 注意

- `path` を指定すると、そのパスを touch していないコミットは出ない
- `verbose=true` は出力が膨らむが、対象ファイルを推測する用途では有用
- `message_contains` は **コミットメッセージ・著者・変更パス**を横断検索するので、author 名を渡しても効く（ただし他のフィールドにもマッチする可能性あり）
- リビジョン範囲（`from_rev`/`to_rev`）と日付範囲（`from_date`/`to_date`）は**排他**。両方指定するとエラー

---

## svn_cat

### 何をするか

`svn cat -r REV PATH` で、指定リビジョン時点のファイル内容を返す。

- 修正前後の比較（ハンク単位）
- 「このリビジョン時点のコードはどうなっていたか」の確認
- ログメッセージとの照合

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `revision` | integer (>0) or `"HEAD"` | ✓ | — | リビジョン番号、または `"HEAD"` |
| `path` | string | ✓ | — | リポジトリ内の相対パス（例: `trunk/src/foo.cpp`） |

### 返却値

ファイル内容そのもの（UTF-8 テキストとして）。

### よく使うクエリ例

```
r142 時点の foo.cpp
→ svn_cat({ revision: 142, path: "trunk/src/foo.cpp" })

最新版
→ svn_cat({ revision: "HEAD", path: "trunk/README.md" })
```

### 注意

- **バイナリファイルには使わない**: 出力は UTF-8 として読まれるので、画像・実行ファイル等は文字化けする
- 大きなファイルは応答が膨らむ。必要なら呼び出し側で行範囲を絞る（svn 側に行範囲取得 API は無いため、全文取得後にスライスする運用）
- 削除済みリビジョンのファイルを cat するときは、削除前のリビジョン番号を指定する

---

## svn_diff

### 何をするか

`svn diff` で unified diff を返す。

- 単一リビジョンの変更内容（`-c REV`）
- リビジョン範囲の差分（`-r FROM:TO`）
- 特定ファイルに絞った差分

ハンク単位の分析や、複数チケットの修正が混在するコミットからの抽出に使う。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `change_rev` | integer (>0) | — | — | 単一リビジョンの差分（`-c REV`）。`from_rev`/`to_rev` を使わない場合に指定 |
| `from_rev` | integer (>0) | — | — | 範囲差分の開始リビジョン（`to_rev` と併用） |
| `to_rev` | integer (>0) or `"HEAD"` | — | — | 範囲差分の終了リビジョン（`from_rev` と併用） |
| `path` | string | — | リビジョン全体 | 特定パスに絞る（例: `trunk/src/foo.cpp`） |

**`change_rev` か `from_rev`+`to_rev` のどちらか必須**。両方とも指定しないとエラー。

### 返却値

unified diff の生のテキスト。差分なしのときは `(差分なし)`。

```
Index: trunk/src/foo.cpp
===================================================================
--- trunk/src/foo.cpp	(revision 141)
+++ trunk/src/foo.cpp	(revision 142)
@@ -10,7 +10,7 @@
-  const TIMEOUT_MS = 3000;
+  const TIMEOUT_MS = 30000;
```

### よく使うクエリ例

```
r142 の変更内容を全部
→ svn_diff({ change_rev: 142 })

r142 の中で foo.cpp の変更だけ
→ svn_diff({ change_rev: 142, path: "trunk/src/foo.cpp" })

r100〜HEAD の foo.cpp の累積差分
→ svn_diff({ from_rev: 100, to_rev: "HEAD", path: "trunk/src/foo.cpp" })
```

### 注意

- 大きなコミットの全差分は出力が膨大になる。`path` で絞るのが基本
- バイナリファイルは `Cannot display: file marked as a binary type.` のような行になり、内容は出ない（svn の仕様）

---

## svn_blame

### 何をするか

指定パスについて **行ごとに「最後に変更したリビジョン・著者」** を返す（`svn blame PATH`）。

「**このバグはいつ誰が入れた？**」「この行はなぜこうなっている？」を調べる定番。blame で判明したリビジョン番号を起点に `svn_log` / `svn_diff` / `svn_cat` を呼んで原因コミットを特定する流れ。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | ✓ | — | リポジトリ内の相対パス。テキストファイル限定 |
| `revision` | integer (>0) or `"HEAD"` or 数字文字列 | — | `HEAD` | blame を取るリビジョン |

### 返却値

`svn blame` の生 stdout。例：

```
   140    alice  #include <stdio.h>
   140    alice
   142    bob    int main(int argc, char **argv) {
   142    bob      const int TIMEOUT_MS = 30000;
   138    alice    printf("hello\n");
   142    bob      return 0;
   140    alice  }
```

左から「リビジョン番号」「著者」「行内容」。

### よく使うクエリ例

```
foo.cpp の 42 行目の責任者を知りたい
→ svn_blame({ path: "trunk/src/foo.cpp" })
→ 結果から 42 行目を見て、そのリビジョンを svn_log や svn_diff で深掘り

過去のあるリビジョン時点での blame
→ svn_blame({ path: "trunk/src/foo.cpp", revision: 100 })
```

### バグ調査の典型フロー

```
1. svn_blame で問題行の最終変更リビジョン X を特定
2. svn_log({ from_rev: X, to_rev: X, verbose: true }) でそのコミットの内容を確認
3. svn_diff({ change_rev: X, path: "..." }) で具体的な変更内容を見る
4. 必要なら svn_cat で前後リビジョンのファイル全体を比較
```

### 注意

- **バイナリファイルには使わない**: テキスト前提
- **大きなファイルは重い**: svn 側で全履歴を辿るため、巨大ファイルは応答が遅い
- 削除済みファイルは blame できない（過去リビジョン指定で対応可能）

---

## find_path

### 何をするか

作業コピー（ローカル WC）配下で **ファイル名を高速検索**する。「`foo.cpp` ってどこ？」を SVN サーバを叩かずに即答できる。

`svn list -R` でリポジトリ全体を取得して LLM 側で grep するよりも高速・低トークン。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `pattern` | string | ✓ | — | ファイル名の部分一致パターン（大小無視） |
| `base` | string | — | WC 全体 | WC ルートからの相対起点（例: `trunk/src`） |
| `limit` | integer | — | `50` | 返却件数上限（最大 500） |

### 返却値

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

### 前提

- `SVN_WORKING_COPY` が設定されていること
- WC が最新であること（新規追加ファイルを見つけたいなら `svn update` 必要）

### よく使うクエリ例

```
foo.cpp ってどこ？
→ find_path({ pattern: "foo.cpp" })

config って名前のファイル全部
→ find_path({ pattern: "config" })

trunk/src 配下の cpp ファイルだけ
→ find_path({ pattern: ".cpp", base: "trunk/src" })
```

### 注意

- `.svn` ディレクトリは自動スキップ
- 大文字小文字を区別しない（"FOO.cpp" でも "foo.cpp" でもヒット）

---

## grep_in_repo

### 何をするか

作業コピー（ローカル WC）内の **テキストファイルからキーワードを grep** する。「関数 `do_login` を呼んでる場所」「このエラーメッセージを出しているコード」を一発で特定。

`svn` サーバを叩かないので高速。バイナリ・巨大ファイル（>2MB）は自動スキップ。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `query` | string | ✓ | — | 検索文字列。`is_regex: true` で正規表現 |
| `is_regex` | boolean | — | `false` | true で query を正規表現として解釈 |
| `case_insensitive` | boolean | — | `false` | 大小無視 |
| `path_filter` | string | — | — | ファイル名の部分一致フィルタ（例: `.cpp`） |
| `base` | string | — | WC 全体 | 検索起点 |
| `max_results` | integer | — | `100` | ヒット件数上限（最大 1000） |

### 返却値

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

### 前提

- `SVN_WORKING_COPY` が設定されていること
- WC が最新であること（古いと最近の変更が反映されない）

### よく使うクエリ例

```
do_login の呼び出し箇所
→ grep_in_repo({ query: "do_login" })

"Connection refused" を出してる場所
→ grep_in_repo({ query: "Connection refused" })

cpp ファイルだけ正規表現で
→ grep_in_repo({
    query: "TODO|FIXME",
    is_regex: true,
    path_filter: ".cpp"
  })

trunk/src 配下で大小無視
→ grep_in_repo({
    query: "logger",
    case_insensitive: true,
    base: "trunk/src"
  })
```

### スキップ条件

| 種類 | 内容 |
|---|---|
| バイナリ拡張子 | `.exe` `.dll` `.png` `.pdf` `.zip` 等は拡張子で即スキップ |
| 巨大ファイル | 2 MB 超 |
| NUL バイト含む | 先頭 512 バイトに `\0` があればバイナリ判定 |
| 長すぎる行 | 1 行が 500 文字超は minified 等とみなしスキップ |
| `.svn/` 配下 | 常にスキップ |

### 注意

- 大規模リポジトリで「全 `path_filter` 無し + よくある単語」だと結果膨大に。なるべく絞る
- 正規表現エラーは即エラー応答
- 行表示は 200 文字までで `…` で切り詰め

---

## show_diff_external

### 何をするか

指定 2 リビジョン × ファイルパス を一時ファイルに展開し、**外部 GUI 差分ツール**（WinMerge 等）を起動する。

- LLM が自動判定した修正候補を、人間が**目視確認**する用途
- AI による誤判定の最終チェック
- 修正の文脈（前後関係）を見たいとき

GUI 起動なので **MCP サーバはホスト OS（Windows/macOS）で動かす必要がある**。Docker / WSL2 内で動かすと表示されない。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `revision_before` | integer (>0) | ✓ | — | 修正前のリビジョン番号 |
| `revision_after` | integer (>0) | ✓ | — | 修正後のリビジョン番号 |
| `path` | string | ✓ | — | リポジトリ内の相対パス |

### 返却値

```jsonc
{
  "message": "外部差分ツールを起動しました。",
  "tool": "C:\\Program Files\\WinMerge\\WinMergeU.exe",
  "pid": 12345,
  "left_file": "C:\\Users\\...\\AppData\\Local\\Temp\\svn-mcp-diff-XXXX\\r141_foo.cpp",
  "right_file": "C:\\Users\\...\\AppData\\Local\\Temp\\svn-mcp-diff-XXXX\\r142_foo.cpp"
}
```

実行内容:
1. `svn cat -r <revision_before> <path>` と `svn cat -r <revision_after> <path>` でファイル取得
2. `os.tmpdir()/svn-mcp-diff-XXXX/r<rev>_<basename>` に書き出し
3. `<toolPath> <leftFile> <rightFile>` を **detached** で spawn
4. ツール終了を待たず即時応答

### 前提

- `.env` に `SVN_EXTERNAL_DIFF_TOOL` が設定されていること。未設定なら呼び出し時にエラー：
  ```
  外部差分ツールが未設定です。環境変数 SVN_EXTERNAL_DIFF_TOOL を .env に設定してください。
  例: SVN_EXTERNAL_DIFF_TOOL=C:\Program Files\WinMerge\WinMergeU.exe
  ```
- MCP サーバがホスト OS で動いていること（Docker 内では GUI が表示されない）

### よく使うクエリ例

```
r141 → r142 の foo.cpp を WinMerge で開く
→ show_diff_external({
    revision_before: 141,
    revision_after: 142,
    path: "trunk/src/foo.cpp"
  })
```

### 注意

- 一時ファイルは OS のクリーンアップに任せる（明示削除しない。GUI が掴んでいる間に消すと不具合になる）
- WinMerge 以外のツール（KDiff3, Beyond Compare 等）も `<tool> <left> <right>` 形式で起動できれば動くはず

---

## show_log_tortoise

### 何をするか

指定パスに対する **TortoiseSVN のログダイアログ**（`TortoiseProc.exe /command:log`）を起動する。

- LLM が推定した修正候補を、人間が **TortoiseSVN で目視確認**する用途
- 「対象ファイルを右クリック → TortoiseSVN → Show Log」と同じ操作を AI 経由で実行
- 内容の信頼性に不安があるときに、人間が普段使う UI で見直せる

GUI 起動なので **MCP サーバはホスト OS（Windows）で動かす必要がある**。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | — | リポジトリルート | リポジトリ内の相対パス（例: `trunk/src/foo.cpp`、`trunk/src`） |

### 返却値

```jsonc
{
  "message": "TortoiseSVN のログダイアログを起動しました。",
  "tool": "C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe",
  "pid": 12345,
  "target_path": "https://svn.example.com/repo/trunk/src/foo.cpp"
}
```

実行内容:
1. `SVN_REPO_URL_CLIENT`（未設定なら `SVN_REPO_URL`）と `path` を連結してターゲットパスを作る
2. `<TortoiseProc.exe> /command:log /path:<target> /closeonend:0` を **detached** で spawn
3. ツール終了を待たず即時応答

### 前提

- `.env` に `SVN_TORTOISE_PROC` が設定されていること。未設定なら呼び出し時にエラー：
  ```
  TortoiseSVN が未設定です。環境変数 SVN_TORTOISE_PROC を .env に設定してください。
  例: SVN_TORTOISE_PROC=C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe
  ```
- MCP サーバがホスト OS（Windows）で動いていること
- **`SVN_REPO_URL` が Windows 側 TortoiseSVN から到達可能であること**。Docker 内 `file:///svn-repo/...` は Windows から見えないため、その場合は `.env` に `SVN_REPO_URL_CLIENT` を設定して Windows 到達可能な URL（`https://...`, `svn+ssh://...`）または作業コピーの絶対パス（`C:\path\to\wc`）を別途指定する

### よく使うクエリ例

```
foo.cpp のログを TortoiseSVN で開く
→ show_log_tortoise({ path: "trunk/src/foo.cpp" })

trunk/src フォルダのログを TortoiseSVN で開く（中身のサブフォルダ含む変更履歴）
→ show_log_tortoise({ path: "trunk/src" })

リポジトリ全体のログ
→ show_log_tortoise()
```

### 注意

- TortoiseSVN ダイアログの開始リビジョンや件数は GUI 側でユーザが操作する（このツールの引数では制御しない）
- TortoiseSVN が初回起動時に資格情報を要求することがある。その場合 GUI 上で入力

---

## open_in_explorer

### 何をするか

作業コピー（ローカル WC）配下の指定パスを **Windows エクスプローラ**で開く。

- ファイル指定 → `explorer.exe /select,<file>` で親フォルダを開いて当該ファイルを**ハイライト表示**
- フォルダ指定 → `explorer.exe <folder>` でフォルダを開く
- パス省略 → WC ルートを開く

「対象ファイルを右クリックして TortoiseSVN で...」という運用の前段として、まず該当場所をエクスプローラで開きたいときに使う。

### 引数

| 名前 | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `path` | string | — | WC ルート | リポジトリ内の相対パス（例: `trunk/src/foo.cpp`、`trunk/src`） |

ファイル／フォルダ判定は実 WC を `fs.statSync` で確認して自動切替する。

### 返却値

```jsonc
{
  "message": "Windows エクスプローラを起動しました。",
  "tool": "explorer.exe",
  "pid": 12345,
  "target_path": "C:\\path\\to\\working-copy\\trunk\\src\\foo.cpp",
  "selected": true
}
```

`selected: true` は `/select,` モード（ファイル選択表示）で開いたことを示す。

### 前提

- `.env` に `SVN_WORKING_COPY` が設定されていること。未設定なら呼び出し時にエラー：
  ```
  作業コピーが未設定です。環境変数 SVN_WORKING_COPY を .env に設定してください。
  例: SVN_WORKING_COPY=C:\path\to\working-copy
  ```
- MCP サーバが Windows ホストで動いていること
- `SVN_WORKING_COPY` 配下に指定パスが**実在すること**（リポジトリにあっても WC に未 checkout なら開けない）

### よく使うクエリ例

```
foo.cpp の場所を開く（親フォルダで選択表示）
→ open_in_explorer({ path: "trunk/src/foo.cpp" })

trunk/src フォルダを開く
→ open_in_explorer({ path: "trunk/src" })

WC ルートを開く
→ open_in_explorer()
```

### 注意

- `SVN_WORKING_COPY` は SVN リポジトリ URL とは**別物**（リモートリポジトリの URL ではなくローカルパス）
- WC が古いと指定ファイルが存在しない可能性あり。`svn update` を済ませた WC を指すのが前提

---

## エラーレスポンスの共通形式

ツールが失敗すると、`isError: true` 付きで以下のような構造化テキストが返る：

### `SvnError`（svn コマンド失敗）

```
svn が exit code 1 で失敗しました: svn: E170000: URL 'file:///svn-repo/my-repo/notfound' non-existent in revision 142

{
  "code": 1,
  "stderr": "svn: E170000: ...",
  "stdout": ""
}
```

### 引数不足（zod 検証は別エラー、ツール側のランタイム検証は errorResult）

```
change_rev か、from_rev と to_rev の組み合わせを指定してください。
```

### 設定不足

```
外部差分ツールが未設定です。環境変数 SVN_EXTERNAL_DIFF_TOOL を .env に設定してください。
```

---

## 拡張する場合

新しい読み取り系ツールを追加する手順：

1. `src/svn/client.ts` の `SvnClient` に対応メソッドを追加（`READ_ONLY_SUBCOMMANDS` に対応サブコマンドが入っているか確認）
2. `src/tools/your-tool.ts` を作成（`src/tools/svn-info.ts` をテンプレートにすると最短）
3. 以下をエクスポート：
   ```ts
   export function register(server: McpServer, ctx: ToolContext) {
     server.registerTool("your_tool", { title, description, inputSchema }, async (args) => { ... });
   }
   ```
4. `src/index.ts` に `import` と `register(server, ctx)` 呼び出しを追加
5. `npm run build` → 再起動

このドキュメントもソースから再生成すること。

詳細は [ARCHITECTURE.md](ARCHITECTURE.md) の「8. 拡張方法」参照。
