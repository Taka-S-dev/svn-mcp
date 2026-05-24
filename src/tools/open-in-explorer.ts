import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openInExplorer } from "../external/explorer.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/foo.cpp、trunk/src）。" +
        "省略時は作業コピーのルートを開く。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "open_in_explorer",
    {
      title: "Windows エクスプローラで開く",
      description:
        "作業コピー（ローカル WC）配下の指定パスを Windows エクスプローラで開く。" +
        "ファイルを指定したときは親フォルダを開いて当該ファイルをハイライト表示する。" +
        "フォルダを指定したときはそのフォルダを開く。" +
        "ユーザが「エクスプローラで開いて」「フォルダ開いて」「該当ファイル見せて」等を求めたときに使う。" +
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
      try {
        const r = openInExplorer(ctx.explorer, { path: args.path });
        return jsonResult({
          message: "Windows エクスプローラを起動しました。",
          tool: r.tool,
          pid: r.pid ?? null,
          target_path: r.targetPath,
          selected: r.selected,
        });
      } catch (err) {
        if (err instanceof Error) {
          return errorResult(`エクスプローラ起動に失敗: ${err.message}`);
        }
        throw err;
      }
    },
  );
}
