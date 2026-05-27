import { z } from "zod";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { walkWc } from "../wc/scanner.js";
import { checkWcFreshness } from "../wc/freshness.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  pattern: z
    .string()
    .min(1)
    .describe(
      "ファイル名の部分一致パターン（大小無視、例: 'foo.cpp' / 'config'）。" +
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

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "find_path",
    {
      title: "WC 内のファイル名検索",
      description:
        "作業コピー（ローカル WC）配下でファイル名を部分一致検索する。" +
        "「foo.cpp ってどこにある？」「config って名前のファイル全部見せて」等に使う。" +
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
      const needle = args.pattern.toLowerCase();
      const matches: { path: string; type: "file" }[] = [];

      // ルートで 1 回 freshness check（per-file ではなく WC 全体に対する 1 回）
      const [freshness, result] = await Promise.all([
        checkWcFreshness(ctx.svn, wc),
        walkWc(wc, {
          base: args.base,
          onFile: (rel) => {
            const basename = path.basename(rel).toLowerCase();
            if (basename.includes(needle)) {
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
