import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SvnError } from "../svn/client.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_describe",
    {
      title: "SVN リポジトリ概要（自己紹介）",
      description:
        "リポジトリの URL、HEAD リビジョン、トップレベル構造、利用可能ツールを一括で返す。" +
        "セッション開始時にまず呼ぶことで、リポジトリの構造（trunk/branches/tags がどこか等）と" +
        "使えるツールを把握できる。LLM が「どこに何があるか分からない」を防ぐためのツール。" +
        "他のツール（svn_log / svn_diff 等）を使う前に 1 回呼ぶことを推奨。",
      inputSchema: {},
    },
    async () => {
      try {
        const [info, list] = await Promise.all([
          ctx.svn.info(),
          ctx.svn.list(),
        ]);

        const revMatch = info.match(/^Revision:\s*(\d+)/m);
        const headRevision = revMatch ? Number(revMatch[1]) : null;

        const topLevel = list
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);

        const hasTrunk = topLevel.includes("trunk/");
        const hasBranches = topLevel.includes("branches/");
        const hasTags = topLevel.includes("tags/");
        const isStandardLayout = hasTrunk && hasBranches && hasTags;

        const hint = isStandardLayout
          ? "trunk / branches / tags の標準レイアウト。ファイル探索は通常 trunk/ 配下から始める。"
          : `非標準レイアウト（trunk=${hasTrunk}, branches=${hasBranches}, tags=${hasTags}）。top_level を見て構造を判断すること。`;

        return jsonResult({
          repo_url: ctx.svn.config.repoUrl,
          docker_mode: ctx.svn.config.useDocker,
          head_revision: headRevision,
          top_level: topLevel,
          tools_available: {
            show_diff_external: ctx.diffTool !== undefined,
            show_log_tortoise: ctx.tortoise !== undefined,
            open_in_explorer: ctx.explorer !== undefined,
          },
          hint,
          info_raw: info,
        });
      } catch (err) {
        if (err instanceof SvnError) {
          return errorResult(err.message, err.detail);
        }
        throw err;
      }
    },
  );
}
