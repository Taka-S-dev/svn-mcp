import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runSvn,
  errorResult,
  sliceLines,
  revOrHeadSchema,
  type ToolContext,
} from "./context.js";

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
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "返す開始行（1 始まり）。blame 出力はファイルの行と 1 対 1 なので、" +
        "問題行の周辺だけに絞ってトークンを節約できる。",
    ),
  end_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("返す終了行（1 始まり・その行を含む）。start_line と併用。"),
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
        "start_line/end_line で行範囲に絞れる（大きいファイルのトークン節約）。" +
        "バイナリファイルには使わない（テキストファイルのみ）。",
      inputSchema: inputShape,
    },
    (args) => {
      if (
        args.start_line != null &&
        args.end_line != null &&
        args.end_line < args.start_line
      ) {
        return Promise.resolve(
          errorResult("end_line は start_line 以上にしてください。"),
        );
      }
      return runSvn(async () => {
        const raw = await ctx.svn.blame(args.path, { revision: args.revision });
        if (args.start_line == null && args.end_line == null) return raw;
        const { text, total, from, to } = sliceLines(
          raw,
          args.start_line,
          args.end_line,
        );
        return `# lines ${from}-${to} of ${total} (${args.path})\n${text}`;
      });
    },
  );
}
