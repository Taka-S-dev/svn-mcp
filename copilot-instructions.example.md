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
| **「チケット #1234 を直したコミットは？」** | `svn_log({ message_contains: "#1234" })`（# 番号や任意キーワードで部分一致） |
| **チケット起票日付近のコミットを探す** | `svn_log({ from_date: "2026-04-10", to_date: "2026-04-20" })` |
| 特定リビジョンのコミット全体の差分 | `svn_diff` `change_rev` |
| 特定リビジョン×特定ファイルの差分 | `svn_diff` `change_rev` + `path` |
| **「このバグはいつ誰が入れた？」「この行はなぜこうなっている？」** | **`svn_blame`**（行ごとの最終変更リビジョン・著者） |
| ファイル一覧（存在確認等） | `svn_list` |
| **「foo.cpp ってどこにある？」「config って名前のファイル」** | **`find_path`**（WC があれば高速。`svn_list -R` より圧倒的に早い） |
| **「do_login の呼び出し箇所」「このエラーメッセージを出してるコード」** | **`grep_in_repo`**（WC があれば高速。バイナリ自動スキップ） |
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

#### チケットの修正コミットを特定（チケット管理ツール連携の主軸）

```
1. （チケット管理ツール側 MCP で）チケット #1234 の対象ファイルと「回覧日／審査日」等の日付フィールドを取得
   - フィールド名は環境固有。最初にメタ情報取得ツール（describe_schema 等）で実フィールド名を確認
2. svn_log({ message_contains: "#1234" })  ← # 番号が書かれてれば一発
3. ヒットしなければ、回覧日を起点に日付範囲で絞り込む:
   svn_log({
     path: "trunk/src/foo.cpp",
     from_date: "<回覧日 -14日>",   // 例: 回覧日 2026-04-15 → 2026-04-01
     to_date:   "<回覧日 +3日>",    // 例: 2026-04-18
     verbose: true
   })
4. 候補コミットを svn_diff({ change_rev: N }) で確認
5. grep_in_repo で関連箇所の整合性も検証
```

**回覧日窓のコツ:**

- コミットは通常**回覧日より前**にされる（実装してから回覧する流れ）→ 窓は**後ろ向きに広く**取る
- 回覧後の指摘修正もありうる → 数日分は前方向にも取る
- 標準窓: 回覧日 −14日 〜 +3日。長期案件なら −30日 〜 +7日
- 候補が多すぎたら `message_contains` でキーワード（チケット件名から拾った語）を併用

#### コミット全体の内容を要約

```
1. svn_log({ from_rev: N, to_rev: "HEAD", verbose: true }) で変更ファイル概観
2. ファイル数が少なければ svn_diff({ change_rev: N }) で全差分
3. ファイル数が多ければ重要そうなファイルだけ svn_diff({ change_rev: N, path: "..." })
```

#### バグの原因調査（責任リビジョン特定）

```
1. svn_blame({ path: "trunk/src/foo.cpp" }) で問題行の最終変更リビジョン X を特定
2. svn_log({ from_rev: X, to_rev: X, verbose: true }) でそのコミットの内容を確認
3. svn_diff({ change_rev: X, path: "..." }) で具体的な変更内容
4. 必要なら svn_cat で前後リビジョンのファイル全体を比較
```

### やってはいけないこと

- **バイナリファイルに `svn_cat` を使わない** — UTF-8 として読まれるので文字化けする。`.png` `.exe` `.zip` 等は触らない
- **`svn_list({ recursive: true })` をいきなり使わない** — 大規模リポジトリで数千ファイルが返る。**WC があるなら `find_path` を優先**（高速・低トークン）。WC が無い／パス推測が必要な場合のみ svn_list を使う
- **`grep_in_repo` の結果が古い可能性に注意** — WC ベースなので `svn update` してないと最新の変更を見落とす。重要な判定では `svn_log` で直近コミットを確認
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
- **`svn: E160013: Diff target '...' was not found in the repository at revisions 'A' and 'B'`** → 指定リビジョン範囲に対象ファイルが存在しなかった。**勝手に再試行せず**、まず `svn_log({ path: "<対象>", verbose: true })` で**そのファイルが触られたリビジョン**を特定してから、その範囲で `svn_diff` を再実行する。ファイルがまだ追加されていない／既に削除されている可能性もある
- `Invalid input: Expected number, received string` 等の Zod エラー → リビジョンは整数（例: `12856`）か `"HEAD"` で渡す。数字だけの文字列 `"12856"` も自動変換されるが、`"v1.0"` 等のタグ名は不可

---

## 環境固有の情報を書き足す場所（実物の方）

実物（`copilot-instructions.md` / `CLAUDE.md`）に追記するとよい例：

- ブランチ命名規則（`trunk` / `branches/release-X.Y` 等）
- よく触るパスのエイリアス
- チケット番号とコミットメッセージの紐付け規則
- 関連する他の MCP サーバー（チケット管理ツール用 MCP 等）との使い分け

このテンプレ自体は汎用的な内容に留めること（環境固有の情報を書かない）。
