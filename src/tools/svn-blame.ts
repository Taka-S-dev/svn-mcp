import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, revOrHeadSchema, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/foo.cpp）。テキストファイルのみ。",
    ),
  revision: revOrHeadSchema
    .optional()
    .describe(
      "blame を取るリビジョン（省略時 HEAD）。数字だけの文字列 \"12856\" も可。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_blame",
    {
      title: "SVN blame（行ごとの最終変更リビジョン・著者）",
      description:
        "指定パスについて行ごとに「最後に変更したリビジョン・著者」を返す（svn blame PATH）。" +
        "「このバグはいつ誰が入れた？」「この行はなぜこうなっている？」を調べる定番。" +
        "blame で判明したリビジョン番号で svn_diff / svn_cat / svn_log を呼んで原因コミットを特定する流れ。" +
        "バイナリファイルには使わない（テキストファイルのみ）。",
      inputSchema: inputShape,
    },
    (args) => runSvn(() => ctx.svn.blame(args.path, { revision: args.revision })),
  );
}
