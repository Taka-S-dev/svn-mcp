# Copilot / Claude Code 向け指示テンプレ（svn-mcp）

このファイルは **テンプレート** です。実運用では以下のいずれかに配置して使う：

- GitHub Copilot CLI: `~/.copilot/copilot-instructions.md` または `<repo>/.github/copilot-instructions.md`
- Claude Code: `<repo>/CLAUDE.md` または `~/.claude/CLAUDE.md`

実物（`copilot-instructions.md` / `CLAUDE.md`）には環境固有の用語・リポジトリ命名規則・ブランチ運用などを書き足すことを想定しているため、`.gitignore` で**追跡対象外**にしてある。テンプレ（`.example.md`）のみコミットする。

---

## svn-mcp の使い方（AI エージェント向け）

このプロジェクトには **svn-mcp**（SVN の読み取り系 MCP サーバー）が登録されている。
ユーザーから SVN リポジトリに関する依頼があったら、以下を参考に効率よく動くこと。

### 基本原則

- **セッション開始時にまず `svn_describe` を呼ぶ** — リポジトリの URL・HEAD リビジョン・トップレベル構造（trunk/branches/tags の有無）・利用可能ツールが 1 回で分かる。これを怠ると「どこに何があるか分からない」迷子状態になり、無駄なツール呼び出しが増える。
- **読み取り専用**: コミット・更新・削除はできない。ユーザーが書き込みを求めても「svn-mcp は読み取り専用です」と返す。
- **生の svn 出力が返る**: ツールは `svn` の stdout をテキストでそのまま返す。パース・整形はそちら（LLM）の仕事。
- **トークン効率を意識**: 大規模リポジトリでは出力が膨れがち。最初は狭く絞り、必要に応じて広げる。

### ツール選択の指針

| やりたいこと | 使うツール |
|---|---|
| **リポジトリの全体像を知りたい（最初に呼ぶ）** | **`svn_describe`** |
| HEAD リビジョン番号を知りたい | `svn_info`（`svn_log limit:1` より軽い） |
| あるパスの変更履歴 | `svn_log` `path` 指定・`limit: 10〜30`・`verbose: true` |
| 特定リビジョンのコミット全体の差分 | `svn_diff` `change_rev` |
| 特定リビジョン×特定ファイルの差分 | `svn_diff` `change_rev` + `path` |
| ファイル一覧（存在確認等） | `svn_list` |
| 特定リビジョン時点のファイル内容 | `svn_cat` |
| 人間に目視で差分を見せたい | `show_diff_external`（ユーザが明示的に「目で見たい」と言ったときだけ） |
| 人間に TortoiseSVN でログ確認させたい | `show_log_tortoise`（ユーザが「TortoiseSVN で見たい」「自分で確認したい」等を求めたとき） |
| 該当ファイル／フォルダを Windows エクスプローラで開きたい | `open_in_explorer`（ユーザが「エクスプローラで開いて」「フォルダ開いて」「ファイルの場所見せて」等を求めたとき） |

### よく使うパターン

#### セッション開始時の準備

```
1. svn_describe()   // リポジトリ URL・HEAD・top_level・使えるツールを把握
2. （以降はその情報を元にパスを組み立てる）
```

#### あるファイルの最近の修正を調べる

```
1. svn_log({ path: "trunk/src/foo.cpp", limit: 10, verbose: true })
2. 興味深いリビジョンが見つかったら svn_diff({ change_rev: N, path: "trunk/src/foo.cpp" })
3. 必要なら svn_cat({ revision: N, path: "..." }) で前後の状態を確認
```

#### コミット全体の内容を要約

```
1. svn_log({ from_rev: N, to_rev: "HEAD", verbose: true }) で変更ファイル概観
2. ファイル数が少なければ svn_diff({ change_rev: N }) で全差分
3. ファイル数が多ければ重要そうなファイルだけ svn_diff({ change_rev: N, path: "..." })
```

### やってはいけないこと

- **バイナリファイルに `svn_cat` を使わない** — UTF-8 として読まれるので文字化けする。`.png` `.exe` `.zip` 等は触らない
- **`svn_list({ recursive: true })` をいきなり使わない** — 大規模リポジトリで数千ファイルが返る。まずトップレベルから掘る
- **`svn_diff` を `path` 無しで大きなコミットに使わない** — リファクタリングコミット等で数千行返ることがある。可能なら `path` で絞る
- **GUI 起動ツール（`show_diff_external` / `show_log_tortoise` / `open_in_explorer`）を勝手に呼ばない** — 画面が立ち上がるので、ユーザの明示要求があるときだけ。判別の目安：
  - 「差分を見せて」→ `svn_diff`（テキスト）
  - 「WinMerge で開いて」「目視で差分確認したい」→ `show_diff_external`
  - 「TortoiseSVN で見たい」「右クリックして確認するみたいに」→ `show_log_tortoise`
  - 「エクスプローラで開いて」「フォルダ開いて」「ファイルの場所見せて」→ `open_in_explorer`

### エラー時の対応

- `svn-mcp は読み取り専用です。サブコマンド 'X' は許可されていません` → 書き込み操作を要求してしまっている。読み取りで代替できないか考える
- `svn コマンドが Nms でタイムアウトしました` → `limit` を減らす、`path` で絞る、`recursive` を外す
- `URL '...' non-existent in revision N` → パスかリビジョンの綴り違い。`svn_info` `svn_list` で存在確認

---

## 環境固有の情報を書き足す場所（実物の方）

実物（`copilot-instructions.md` / `CLAUDE.md`）に追記するとよい例：

- ブランチ命名規則（`trunk` / `branches/release-X.Y` 等）
- よく触るパスのエイリアス
- チケット番号とコミットメッセージの紐付け規則
- 関連する他の MCP サーバー（チケット管理ツール用 MCP 等）との使い分け

このテンプレ自体は汎用的な内容に留めること（環境固有の情報を書かない）。
