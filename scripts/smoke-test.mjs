#!/usr/bin/env node
/**
 * svn-mcp 疎通テスト。
 *
 * dist/index.js を spawn して MCP プロトコルで主要ツールを呼び、結果を表示する。
 * リポジトリへの実接続が成立しているか・各ツールが応答するかを確認する用途。
 *
 * 使い方:
 *   1. .env を整備
 *   2. npm run build
 *   3. npm run smoke    （または node scripts/smoke-test.mjs）
 *
 * 結果ステータス:
 *   PASS - 正常に応答
 *   SKIP - 実行するための環境変数が未設定（ツールが無効化されている）
 *   FAIL - ツールが応答しない／エラー応答／期待外の動作
 *
 * 終了コード:
 *   0 - FAIL ゼロ（PASS と SKIP のみ）
 *   1 - いずれかのテストが FAIL
 *   2 - クラッシュ等
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distEntry = path.join(projectRoot, "dist", "index.js");

const EXPECTED_TOOLS = [
  "svn_describe",
  "svn_info",
  "svn_list",
  "svn_log",
  "svn_cat",
  "svn_diff",
  "svn_blame",
  "find_path",
  "grep_in_repo",
  "show_diff_external",
  "show_log_tortoise",
  "open_in_explorer",
];

/**
 * 「未設定エラー」を識別するパターン。
 * 該当する errorResult は FAIL でなく SKIP として扱う。
 * 各ツールが errorResult メッセージに含めている語と整合させること。
 */
const UNCONFIGURED_PATTERNS = [
  /未設定/, // 「作業コピーが未設定」「TortoiseSVN が未設定」「外部差分ツールが未設定」
];

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? " — " + detail : ""}`);
}

function previewText(text, max = 80) {
  if (!text) return "(empty)";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function isUnconfiguredError(text) {
  return UNCONFIGURED_PATTERNS.some((re) => re.test(text));
}

async function tryCall(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text ?? "";
    if (r?.isError) {
      if (isUnconfiguredError(text)) {
        record(name, "SKIP", previewText(text));
      } else {
        record(name, "FAIL", previewText(text));
      }
    } else {
      record(name, "PASS", `${text.length} chars: ${previewText(text)}`);
    }
  } catch (err) {
    record(name, "FAIL", err?.message ?? String(err));
  }
}

async function main() {
  console.log("svn-mcp smoke test");
  console.log("==================");
  console.log(`Project: ${projectRoot}`);
  console.log(`Entry:   ${distEntry}`);
  console.log("");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--env-file=.env", distEntry],
    cwd: projectRoot,
  });

  const client = new Client(
    { name: "svn-mcp-smoke", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    record("connect", "PASS", "MCP handshake OK");
  } catch (err) {
    record("connect", "FAIL", err?.message ?? String(err));
    process.exit(2);
  }

  // 1. listTools で登録ツールを確認
  let registered = [];
  try {
    const { tools } = await client.listTools();
    registered = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((n) => !registered.includes(n));
    if (missing.length > 0) {
      record("listTools", "FAIL", `missing: ${missing.join(", ")}`);
    } else {
      record("listTools", "PASS", `${registered.length} tools registered`);
    }
  } catch (err) {
    record("listTools", "FAIL", err?.message ?? String(err));
  }

  // 2. svn_describe（最重要：サーバ接続と構造把握）
  await tryCall(client, "svn_describe", {});

  // 3. svn_info（ルート）
  await tryCall(client, "svn_info", {});

  // 4. svn_list（ルート）
  await tryCall(client, "svn_list", {});

  // 5. svn_log limit:1
  await tryCall(client, "svn_log", { limit: 1 });

  // 6. WC 系（SVN_WORKING_COPY 未設定なら自動的に SKIP になる）
  if (registered.includes("find_path")) {
    await tryCall(client, "find_path", { pattern: ".", limit: 1 });
  }
  if (registered.includes("grep_in_repo")) {
    await tryCall(client, "grep_in_repo", {
      query: "the",
      max_results: 1,
    });
  }

  // GUI 起動系は smoke では呼ばない（GUI が立ち上がるため）
  // SVN_TORTOISE_PROC / SVN_EXTERNAL_DIFF_TOOL の有無は startup ログで確認

  // 終了処理
  try {
    await client.close();
  } catch {
    // ignore
  }

  // サマリ
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  console.log("");
  console.log(`Result: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (failed > 0) {
    console.log("");
    console.log("Failed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.detail ?? "(no detail)"}`);
    }
  }

  if (skipped > 0) {
    console.log("");
    console.log("Skipped tests (環境変数で有効化できる):");
    for (const r of results.filter((r) => r.status === "SKIP")) {
      console.log(`  - ${r.name}: ${r.detail ?? "(no detail)"}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
