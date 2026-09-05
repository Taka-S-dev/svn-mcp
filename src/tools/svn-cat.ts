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
  revision: revOrHeadSchema
    .describe("リビジョン番号、または 'HEAD'。数字だけの文字列 \"12856\" も可。"),
  path: z
    .string()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/foo.cpp）。",
    ),
  start_line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "返す開始行（1 始まり）。指定するとこの行以降だけ返す。" +
        "大きいファイルで対象箇所だけ見たいときにトークンを節約できる。",
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
    "svn_cat",
    {
      title: "SVN 指定リビジョンのファイル取得",
      description:
        "指定リビジョンのファイル内容をテキストで返す（svn cat -r REV PATH）。" +
        "修正前後の比較・ハンク単位の分析・ログメッセージとの照合に使う。" +
        "start_line/end_line で行範囲に絞れる（大きいファイルのトークン節約）。" +
        "バイナリファイルには使わないこと（UTF-8 として読まれる）。",
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
        const raw = await ctx.svn.cat(args.revision, args.path);
        if (args.start_line == null && args.end_line == null) return raw;
        const { text, total, from, to } = sliceLines(
          raw,
          args.start_line,
          args.end_line,
        );
        return `# lines ${from}-${to} of ${total} (${args.path} @ r${args.revision})\n${text}`;
      });
    },
  );
}
