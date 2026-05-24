import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SvnError } from "../svn/client.js";
import { showDiffExternal } from "../external/diff-tool.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  revision_before: z
    .number()
    .int()
    .positive()
    .describe("修正前のリビジョン番号（例: 修正コミットの1つ前）。"),
  revision_after: z
    .number()
    .int()
    .positive()
    .describe("修正後のリビジョン番号（例: 修正コミット）。"),
  path: z
    .string()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/core/state_manager.cpp）。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "show_diff_external",
    {
      title: "差分を外部ツール（WinMerge等）で開く",
      description:
        "指定2リビジョン×指定パスのファイルを一時ファイルに取り出し、外部差分ツール（WinMerge等）を起動する。" +
        "LLMの自動判定後、人間が目視で修正内容を確認するために使う。" +
        "GUIを起動する性質上、MCPサーバはホスト（Windows/macOS）で動作している必要がある。" +
        "事前に環境変数 SVN_EXTERNAL_DIFF_TOOL でツールのフルパスを指定しておくこと。",
      inputSchema: inputShape,
    },
    async (args) => {
      if (!ctx.diffTool) {
        return errorResult(
          "外部差分ツールが未設定です。環境変数 SVN_EXTERNAL_DIFF_TOOL を .env に設定してください。" +
            "例: SVN_EXTERNAL_DIFF_TOOL=C:\\Program Files\\WinMerge\\WinMergeU.exe",
        );
      }
      try {
        const r = await showDiffExternal(ctx.svn, ctx.diffTool, {
          revisionBefore: args.revision_before,
          revisionAfter: args.revision_after,
          path: args.path,
        });
        return jsonResult({
          message: "外部差分ツールを起動しました。",
          tool: r.tool,
          pid: r.pid,
          left_file: r.leftFile,
          right_file: r.rightFile,
        });
      } catch (err) {
        if (err instanceof SvnError) {
          return errorResult(err.message, err.detail);
        }
        if (err instanceof Error) {
          return errorResult(`外部ツール起動に失敗: ${err.message}`);
        }
        throw err;
      }
    },
  );
}
