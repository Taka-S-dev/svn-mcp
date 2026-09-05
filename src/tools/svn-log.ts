import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runSvn, errorResult, revOrHeadSchema, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/foo.cpp）。" +
        "指定すると、そのパスに対する変更履歴のみが返る。省略時はリポジトリ全体。",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(50)
    .describe(
      "返す最大コミット数（svn log --limit N）。既定 50。" +
        "全件が必要な場合のみ大きな値を指定する。履歴の長いファイルは既定のままで十分なことが多い。",
    ),
  verbose: z
    .boolean()
    .optional()
    .describe(
      "true で各コミットの変更パス一覧（A/M/D）も付与する（svn log -v）。" +
        "対象ファイルを推測する用途では true が有用。",
    ),
  from_rev: revOrHeadSchema
    .optional()
    .describe(
      "範囲指定の開始リビジョン（例: 100 または 'HEAD'）。to_rev と併用。" +
        "from_date/to_date とは排他。数字だけの文字列 \"100\" も可。",
    ),
  to_rev: revOrHeadSchema
    .optional()
    .describe(
      "範囲指定の終了リビジョン（例: 200 または 'HEAD'）。from_rev と併用。" +
        "from_date/to_date とは排他。数字だけの文字列 \"200\" も可。",
    ),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "日付範囲の開始（YYYY-MM-DD）。to_date と併用。from_rev/to_rev とは排他。" +
        "「チケット起票日付近のコミット」を絞り込むのに使う。",
    ),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "日付範囲の終了（YYYY-MM-DD）。from_date と併用。from_rev/to_rev とは排他。",
    ),
  message_contains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "コミットメッセージ／著者／変更パスの部分一致検索（svn log --search）。" +
        "例: '#1234'（チケット番号）, 'login'（キーワード）, 'alice'（著者名）。" +
        "path・日付範囲・リビジョン範囲と組み合わせ可。",
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
        "範囲はリビジョン（from_rev/to_rev）か日付（from_date/to_date）で絞れる（排他）。" +
        "message_contains でコミットメッセージ部分一致検索（チケット番号やキーワード）。",
      inputSchema: inputShape,
    },
    async (args) => {
      const hasRevRange = args.from_rev != null || args.to_rev != null;
      const hasDateRange = args.from_date != null || args.to_date != null;
      if (hasRevRange && hasDateRange) {
        return errorResult(
          "from_rev/to_rev と from_date/to_date は同時に指定できません。どちらか一方を選んでください。",
        );
      }
      // message_contains（svn log --search）を path・範囲とも無指定で使うと
      // リポジトリ全体の全履歴をスキャンし、ヒットしないケースでタイムアウト→空結果になる。
      // 少なくとも path か日付/リビジョン範囲で絞らせる。
      if (args.message_contains && !args.path && !hasRevRange && !hasDateRange) {
        return errorResult(
          "message_contains をリポジトリ全体・全履歴に対して使うとタイムアウトする可能性があります。" +
            "path（ファイル/ディレクトリ）で絞るか、from_date/to_date または from_rev/to_rev で範囲を限定してください。",
        );
      }
      return runSvn(() =>
        ctx.svn.log(args.path, {
          limit: args.limit,
          verbose: args.verbose,
          fromRev: args.from_rev,
          toRev: args.to_rev,
          fromDate: args.from_date,
          toDate: args.to_date,
          messageContains: args.message_contains,
        }),
      );
    },
  );
}
