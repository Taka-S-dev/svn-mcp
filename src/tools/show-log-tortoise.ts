import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { showLogInTortoise } from "../external/tortoise.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "リポジトリ内の相対パス（例: trunk/src/foo.cpp、trunk/src）。" +
        "省略時はリポジトリルートのログ。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "show_log_tortoise",
    {
      title: "TortoiseSVN のログダイアログを開く",
      description:
        "指定パスに対する TortoiseSVN のログダイアログ（svn log GUI）を起動する。" +
        "LLM が推定した修正候補を、人間が TortoiseSVN で目視確認するために使う。" +
        "ユーザが「TortoiseSVN で見たい」「自分の目で確認したい」等を求めたときに使う。" +
        "GUI を起動する性質上、MCP サーバはホスト（Windows）で動作している必要がある。" +
        "事前に環境変数 SVN_TORTOISE_PROC で TortoiseProc.exe のフルパスを指定しておくこと。",
      inputSchema: inputShape,
    },
    async (args) => {
      if (!ctx.tortoise) {
        return errorResult(
          "TortoiseSVN が未設定です。環境変数 SVN_TORTOISE_PROC を .env に設定してください。" +
            "例: SVN_TORTOISE_PROC=C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe",
        );
      }
      try {
        const r = showLogInTortoise(
          ctx.tortoise,
          ctx.svn.config.repoUrl,
          { path: args.path },
        );
        return jsonResult({
          message: "TortoiseSVN のログダイアログを起動しました。",
          tool: r.tool,
          pid: r.pid ?? null,
          target_path: r.targetPath,
        });
      } catch (err) {
        if (err instanceof Error) {
          return errorResult(`TortoiseSVN の起動に失敗: ${err.message}`);
        }
        throw err;
      }
    },
  );
}
