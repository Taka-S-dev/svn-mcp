import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src）。省略時はリポジトリルート。",
    ),
  recursive: z
    .boolean()
    .optional()
    .describe(
      "true で再帰的に全ファイルを列挙する（svn list -R）。" +
        "大規模リポジトリでは出力が膨らむため、必要なときだけ true にすること。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_list",
    {
      title: "SVN ファイル一覧",
      description:
        "SVN リポジトリのファイル/ディレクトリ一覧を返す。" +
        "チケット記載のファイル名から実パスを探す、修正対象ファイルの存在確認、" +
        "といった用途に使う。recursive=true で全ファイル列挙可能。",
      inputSchema: inputShape,
    },
    (args) => runSvn(() => ctx.svn.list(args.path, { recursive: args.recursive })),
  );
}
