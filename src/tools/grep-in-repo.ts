import { z } from "zod";
import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { walkWc, isLikelyBinaryByExt, hasNullByte } from "../wc/scanner.js";
import { checkWcFreshness } from "../wc/freshness.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB を超えるファイルはスキップ
const MAX_LINE_LENGTH = 500; // 1 行が長すぎる minified ファイル等はスキップ

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe("検索する文字列。is_regex=true なら正規表現として解釈。"),
  is_regex: z
    .boolean()
    .optional()
    .default(false)
    .describe("true で query を正規表現として扱う。"),
  case_insensitive: z
    .boolean()
    .optional()
    .default(false)
    .describe("大文字小文字を無視（既定 false）。"),
  path_filter: z
    .string()
    .optional()
    .describe(
      "対象ファイル名の部分一致フィルタ（例: '.cpp' で C++ ファイルだけ）。省略時は全テキストファイル。",
    ),
  base: z
    .string()
    .optional()
    .describe("WC ルートからの相対パスで検索起点を絞る（例: 'trunk/src'）。"),
  max_results: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .default(100)
    .describe("返却するヒット件数の上限（既定 100、最大 1000）。"),
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "grep_in_repo",
    {
      title: "WC 内のキーワード検索（grep）",
      description:
        "作業コピー（ローカル WC）内のテキストファイルからキーワードを grep する。" +
        "「関数 do_login を呼んでる場所」「このエラーメッセージを出してるコード」等を一発で見つける。" +
        "SVN サーバを叩かないので高速。バイナリ・巨大ファイル（>2MB）は自動スキップ。" +
        "**注意**: WC が古いと最新の変更が反映されていない可能性あり。" +
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
      const wc = ctx.explorer.workingCopyPath;

      let regex: RegExp;
      try {
        const pattern = args.is_regex ? args.query : escapeRegExp(args.query);
        regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
      } catch (err) {
        return errorResult(
          `正規表現が不正です: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const pathFilter = args.path_filter?.toLowerCase();
      const hits: { path: string; line: number; text: string }[] = [];
      let skippedBinary = 0;
      let skippedLarge = 0;

      // ルートで 1 回 freshness check（per-file ではない）。walk と並列。
      const freshnessPromise = checkWcFreshness(ctx.svn, wc);

      const result = await walkWc(wc, {
        base: args.base,
        onFile: async (rel, abs) => {
          if (pathFilter && !rel.toLowerCase().includes(pathFilter)) return false;
          if (isLikelyBinaryByExt(rel)) {
            skippedBinary++;
            return false;
          }

          let stat;
          try {
            stat = await fs.stat(abs);
          } catch {
            return false;
          }
          if (stat.size > MAX_FILE_SIZE) {
            skippedLarge++;
            return false;
          }

          if (await hasNullByte(abs)) {
            skippedBinary++;
            return false;
          }

          let content: string;
          try {
            content = await fs.readFile(abs, "utf8");
          } catch {
            return false;
          }

          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > MAX_LINE_LENGTH) continue;
            if (regex.test(line)) {
              hits.push({
                path: rel,
                line: i + 1,
                text: line.length > 200 ? line.slice(0, 200) + "…" : line,
              });
              if (hits.length >= args.max_results) return true;
            }
          }
          return false;
        },
      });

      const freshness = await freshnessPromise;

      return jsonResult({
        wc_path: wc,
        query: args.query,
        is_regex: args.is_regex,
        case_insensitive: args.case_insensitive,
        path_filter: args.path_filter ?? null,
        base: args.base ?? null,
        hits,
        hit_count: hits.length,
        files_scanned: result.scanned,
        skipped_binary: skippedBinary,
        skipped_large: skippedLarge,
        truncated: result.stopped,
        note: result.stopped
          ? `max_results ${args.max_results} に達したため打ち切り。query を絞るか path_filter で対象を限定して。`
          : null,
        wc_freshness: freshness,
        warning: freshness.warning,
      });
    },
  );
}
