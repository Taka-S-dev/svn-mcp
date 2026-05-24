import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, type ToolContext } from "./context.js";

const inputShape = {
  revision: z
    .union([z.number().int().positive(), z.literal("HEAD")])
    .describe("リビジョン番号、または 'HEAD'。"),
  path: z
    .string()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/core/state_manager.cpp）。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_cat",
    {
      title: "SVN 指定リビジョンのファイル取得",
      description:
        "指定リビジョンのファイル内容をテキストで返す（svn cat -r REV PATH）。" +
        "修正前後の比較・ハンク単位の分析・ログメッセージとの照合に使う。" +
        "バイナリファイルには使わないこと（UTF-8 として読まれる）。",
      inputSchema: inputShape,
    },
    (args) => runSvn(() => ctx.svn.cat(args.revision, args.path)),
  );
}
