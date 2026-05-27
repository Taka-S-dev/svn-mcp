import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SvnError } from "../svn/client.js";
import { getLocalWcRevision, buildFreshnessInfo } from "../wc/freshness.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "svn_describe",
    {
      title: "SVN リポジトリ概要（自己紹介）",
      description:
        "リポジトリの URL、HEAD リビジョン、トップレベル構造、利用可能ツール、" +
        "作業コピー（設定時）の最新性を一括で返す。" +
        "セッション開始時にまず呼ぶことで、リポジトリの構造（trunk/branches/tags がどこか等）と" +
        "使えるツール、WC が古くないかを把握できる。LLM が「どこに何があるか分からない」を防ぐ。" +
        "他のツール（svn_log / svn_diff 等）を使う前に 1 回呼ぶことを推奨。",
      inputSchema: {},
    },
    async () => {
      try {
        // WC があれば freshness も並列で取得（svn info 2 回 + svn list 1 回が並列）
        const [info, list, wcRev] = await Promise.all([
          ctx.svn.info(),
          ctx.svn.list(),
          ctx.explorer
            ? getLocalWcRevision(ctx.explorer.workingCopyPath)
            : Promise.resolve(null),
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

        // WC が設定されているときだけ freshness を計算
        const wcFreshness = ctx.explorer
          ? buildFreshnessInfo(wcRev, headRevision)
          : null;

        // hint はレイアウト + WC freshness の両方を反映
        const hintParts: string[] = [];
        hintParts.push(
          isStandardLayout
            ? "trunk / branches / tags の標準レイアウト。ファイル探索は通常 trunk/ 配下から始める。"
            : `非標準レイアウト（trunk=${hasTrunk}, branches=${hasBranches}, tags=${hasTags}）。top_level を見て構造を判断すること。`,
        );
        if (wcFreshness?.fresh === false && wcFreshness.behind_by != null) {
          hintParts.push(
            `WC が ${wcFreshness.behind_by} コミット遅れている。find_path / grep_in_repo の結果は古い可能性あり。svn update を推奨。`,
          );
        } else if (wcFreshness?.fresh === null) {
          hintParts.push(
            `WC 最新性が判定不能（ホストに svn コマンドが必要）。${wcFreshness.warning ?? ""}`,
          );
        }

        return jsonResult({
          repo_url: ctx.svn.config.repoUrl,
          docker_mode: ctx.svn.config.useDocker,
          head_revision: headRevision,
          top_level: topLevel,
          tools_available: {
            show_diff_external: ctx.diffTool !== undefined,
            show_log_tortoise: ctx.tortoise !== undefined,
            open_in_explorer: ctx.explorer !== undefined,
            find_path: ctx.explorer !== undefined,
            grep_in_repo: ctx.explorer !== undefined,
          },
          wc_freshness: wcFreshness,
          hint: hintParts.join(" "),
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
