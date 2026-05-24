import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/core/state_manager.cpp）。" +
        "指定すると、そのパスに対する変更履歴のみが返る。省略時はリポジトリ全体。",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "返す最大コミット数（svn log --limit N）。デフォルトなし（全件）。" +
        "履歴の長いファイルでは 20〜50 程度に絞ること。",
    ),
  verbose: z
    .boolean()
    .optional()
    .describe(
      "true で各コミットの変更パス一覧（A/M/D）も付与する（svn log -v）。" +
        "対象ファイルを推測する用途では true が有用。",
    ),
  from_rev: z
    .union([z.number().int().positive(), z.literal("HEAD")])
    .optional()
    .describe(
      "範囲指定の開始リビジョン（例: 100 または 'HEAD'）。to_rev と併用。",
    ),
  to_rev: z
    .union([z.number().int().positive(), z.literal("HEAD")])
    .optional()
    .describe(
      "範囲指定の終了リビジョン（例: 200 または 'HEAD'）。from_rev と併用。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_log",
    {
      title: "SVN コミット履歴取得",
      description:
        "SVN のコミット履歴を返す。" +
        "あるファイルパスから、最近の修正コミットを特定する起点として使う。" +
        "verbose=true で各コミットの変更ファイル一覧も取得できる。" +
        "リビジョン範囲は from_rev / to_rev で絞り込み可能。",
      inputSchema: inputShape,
    },
    (args) =>
      runSvn(() =>
        ctx.svn.log(args.path, {
          limit: args.limit,
          verbose: args.verbose,
          fromRev: args.from_rev,
          toRev: args.to_rev,
        }),
      ),
  );
}
