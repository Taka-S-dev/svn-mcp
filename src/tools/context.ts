import { z } from "zod";
import { SvnError, type SvnClient } from "../svn/client.js";
import type { DiffToolConfig } from "../external/diff-tool.js";
import type { TortoiseConfig } from "../external/tortoise.js";
import type { ExplorerConfig } from "../external/explorer.js";

export interface ToolContext {
  svn: SvnClient;
  /** show_diff_external の設定。未設定なら GUI 起動ツールは使えない。 */
  diffTool?: DiffToolConfig;
  /** show_log_tortoise の設定。未設定なら TortoiseSVN 起動ツールは使えない。 */
  tortoise?: TortoiseConfig;
  /** open_in_explorer の設定（作業コピーパス）。未設定なら Explorer 起動ツールは使えない。 */
  explorer?: ExplorerConfig;
}

export interface ToolResult {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * テキストを行範囲（1 始まり・end は含む）で切り出す。
 * start/end とも未指定なら素通し。大きな svn cat / blame 出力を LLM に返す前に
 * 目的行だけに絞ってトークンを節約する用途。
 */
export function sliceLines(
  text: string,
  start?: number,
  end?: number,
): { text: string; total: number; from: number; to: number; sliced: boolean } {
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  if (start == null && end == null) {
    return { text, total, from: 1, to: total, sliced: false };
  }
  const from = Math.max(1, start ?? 1);
  const to = Math.min(total, end ?? total);
  return { text: lines.slice(from - 1, to).join("\n"), total, from, to, sliced: true };
}

export function errorResult(message: string, detail?: unknown): ToolResult {
  const body =
    detail !== undefined
      ? `${message}\n\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`
      : message;
  return {
    content: [{ type: "text", text: body }],
    isError: true,
  };
}

/**
 * svn 呼び出しを実行し、stdout を textResult で包んで返す。
 * SvnError は errorResult に変換する。それ以外の例外はそのまま投げる。
 */
export async function runSvn(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof SvnError) {
      return errorResult(err.message, err.detail);
    }
    throw err;
  }
}

/**
 * LLM が誤って "12856" のような数字文字列を渡しても受け付ける number スキーマ。
 * 数字だけの文字列は Number() で正の整数に変換、それ以外は素通り（後続スキーマで検証）。
 */
const coerceIntStringPreprocess = (v: unknown): unknown => {
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    return Number(v.trim());
  }
  return v;
};

/** 正の整数のリビジョン。"12856" のような文字列も受け付ける。 */
export const revNumberSchema = z.preprocess(
  coerceIntStringPreprocess,
  z.number().int().positive(),
);

/** 正の整数のリビジョン または 'HEAD'。"12856" のような文字列も受け付ける。 */
export const revOrHeadSchema = z.preprocess(
  coerceIntStringPreprocess,
  z.union([z.number().int().positive(), z.literal("HEAD")]),
);
