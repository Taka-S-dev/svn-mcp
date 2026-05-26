import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runSvn,
  errorResult,
  revNumberSchema,
  revOrHeadSchema,
  type ToolContext,
} from "./context.js";

const inputShape = {
  change_rev: revNumberSchema
    .optional()
    .describe(
      "単一リビジョンの差分を取りたい場合に指定（svn diff -c REV）。" +
        "from_rev/to_rev を使う場合は不要。数字だけの文字列 \"123\" も可。",
    ),
  from_rev: revNumberSchema
    .optional()
    .describe("範囲差分の開始リビジョン（to_rev と併用）。数字だけの文字列 \"123\" も可。"),
  to_rev: revOrHeadSchema
    .optional()
    .describe("範囲差分の終了リビジョン（from_rev と併用）。数字だけの文字列 \"123\" も可。"),
  path: z
    .string()
    .optional()
    .describe(
      "差分対象を特定のパスに絞る（例: trunk/src/core/state_manager.cpp）。" +
        "省略時はリビジョンの全変更を取得。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_diff",
    {
      title: "SVN 差分取得（unified diff）",
      description:
        "SVN の差分を unified diff 形式で返す。" +
        "単一リビジョンは change_rev、範囲は from_rev/to_rev を使う。" +
        "path を指定すれば特定ファイルに絞れる。" +
        "ハンク単位の分析や、複数チケット修正が混在するコミットからの抽出に使う。",
      inputSchema: inputShape,
    },
    async (args) => {
      if (
        args.change_rev == null &&
        (args.from_rev == null || args.to_rev == null)
      ) {
        return errorResult(
          "change_rev か、from_rev と to_rev の組み合わせを指定してください。",
        );
      }
      return runSvn(async () => {
        const out = await ctx.svn.diff({
          changeRev: args.change_rev,
          fromRev: args.from_rev,
          toRev: args.to_rev,
          path: args.path,
        });
        return out || "(差分なし)";
      });
    },
  );
}
