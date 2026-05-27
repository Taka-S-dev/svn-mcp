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
 * 終了コード:
 *   0 - 全テスト pass
 *   1 - いずれかのテストが fail
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

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
}

function previewText(text, max = 80) {
  if (!text) return "(empty)";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function tryCall(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text ?? "";
    if (r?.isError) {
      record(name, false, previewText(text));
    } else {
      record(name, true, `${text.length} chars: ${previewText(text)}`);
    }
  } catch (err) {
    record(name, false, err?.message ?? String(err));
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
    record("connect", true, "MCP handshake OK");
  } catch (err) {
    record("connect", false, err?.message ?? String(err));
    process.exit(2);
  }

  // 1. listTools で登録ツールを確認
  let registered = [];
  try {
    const { tools } = await client.listTools();
    registered = tools.map((t) => t.name);
    const missing = EXPECTED_TOOLS.filter((n) => !registered.includes(n));
    if (missing.length > 0) {
      record("listTools", false, `missing: ${missing.join(", ")}`);
    } else {
      record("listTools", true, `${registered.length} tools registered`);
    }
  } catch (err) {
    record("listTools", false, err?.message ?? String(err));
  }

  // 2. svn_describe（最重要：サーバ接続と構造把握）
  await tryCall(client, "svn_describe", {});

  // 3. svn_info（ルート）
  await tryCall(client, "svn_info", {});

  // 4. svn_list（ルート）
  await tryCall(client, "svn_list", {});

  // 5. svn_log limit:1
  await tryCall(client, "svn_log", { limit: 1 });

  // 6. find_path（WC 設定時のみ意味あり。設定無しなら errorResult が返る想定）
  if (registered.includes("find_path")) {
    // 単純な存在確認: 1 文字パターンで limit:1
    await tryCall(client, "find_path", { pattern: ".", limit: 1 });
  }

  // 終了処理
  try {
    await client.close();
  } catch {
    // ignore
  }

  // サマリ
  console.log("");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`Result: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("");
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail ?? "(no detail)"}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
