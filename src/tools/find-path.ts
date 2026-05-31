import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { walkWc } from "../wc/scanner.js";
import { checkWcFreshness } from "../wc/freshness.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  pattern: z
    .string()
    .min(1)
    .describe(
      "WC 相対パスの部分一致パターン（大小無視、`\\` は `/` に正規化される）。" +
        "ファイル名・フォルダ名・パス全体のどこに含まれていてもヒット。" +
        "例: 'foo.cpp' / 'src/external/foo.c' / 'extend/' / 'XYZ/my-repo/extend/foo.c'" +
        "（最後のように prefix が WC に無くてもサフィックスが一致すれば見つかる）。" +
        "正規表現ではなく単純な部分一致。",
    ),
  base: z
    .string()
    .optional()
    .describe(
      "WC ルートからの相対パスで検索起点を絞る（例: 'trunk/src'）。省略時は WC 全体。",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(50)
    .describe("返却するマッチ件数の上限（既定 50、最大 500）。"),
};

/**
 * needle がパスのどこかに含まれているかを判定（部分一致、大小無視、区切り正規化）。
 *
 * "foo.cpp" / "src/external/foo.c" / "extend/" など、どんなレベルの一部でもマッチする。
 * 外部由来のパス（チケット記述、UNC、project prefix 付き等）も、basename か末尾の数階層が
 * WC のパスに含まれていれば見つかる。
 */
function pathMatches(rel: string, needle: string): boolean {
  const normalizedRel = rel.replace(/\\/g, "/").toLowerCase();
  return normalizedRel.includes(needle);
}

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "find_path",
    {
      title: "WC 内のパス検索",
      description:
        "作業コピー（ローカル WC）配下でパスを部分一致検索する。" +
        "ファイル名だけ・フォルダ名・パスの一部、どれでもマッチする。" +
        "「foo.cpp ってどこ？」「src/external 配下のファイル」等の用途。" +
        "**外部由来のパス（チケット記述・会話・UNC 等）の正規化**にも使う: " +
        "そのまま渡しても WC にあれば見つかるし、prefix が違うパスでも末尾が合えばヒットする。" +
        "SVN サーバを叩かないので大規模リポジトリでも高速。" +
        "**注意**: WC が古いと最近追加されたファイルは出ない。" +
        "事前に環境変数 SVN_WORKING_COPY で作業コピーの絶対パスを指定しておくこと。",
      inputSchema: inputShape,
    },
    async (args) => {
      if (!ctx.explorer) {
        return errorResult(
          "作業コピーが未設定です。環境変数 SVN_WORKING_COPY を .env に設定してください。" +
            "例: SVN_WORKING_COPY=C:\\path\\to\\working-copy",
        );
      }
      const wc = ctx.explorer.workingCopyPath;
      // 入力パターンも区切り正規化＋小文字化（Windows 区切り混入に強くする）
      const needle = args.pattern.replace(/\\/g, "/").toLowerCase();
      const matches: { path: string; type: "file" }[] = [];

      // ルートで 1 回 freshness check（per-file ではなく WC 全体に対する 1 回）
      const [freshness, result] = await Promise.all([
        checkWcFreshness(ctx.svn, wc),
        walkWc(wc, {
          base: args.base,
          onFile: (rel) => {
            if (pathMatches(rel, needle)) {
              matches.push({ path: rel, type: "file" });
              return matches.length >= args.limit;
            }
            return false;
          },
        }),
      ]);

      return jsonResult({
        wc_path: wc,
        base: args.base ?? null,
        pattern: args.pattern,
        matches,
        count: matches.length,
        files_scanned: result.scanned,
        truncated: result.stopped,
        note: result.stopped
          ? `limit ${args.limit} に達したため打ち切り。pattern を絞るか base で範囲指定を。`
          : null,
        wc_freshness: freshness,
        warning: freshness.warning,
      });
    },
  );
}
