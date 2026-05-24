import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk）。省略時はリポジトリルートの info を返す。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_info",
    {
      title: "SVN リポジトリ情報取得",
      description:
        "SVN リポジトリまたは特定パスの info を返す（リビジョン、URL、最終更新者など）。" +
        "リポジトリの存在確認やHEADリビジョン取得に使う。",
      inputSchema: inputShape,
    },
    (args) => runSvn(() => ctx.svn.info(args.path)),
  );
}
