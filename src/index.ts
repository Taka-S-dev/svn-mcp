#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SvnClient, type SvnConfig } from "./svn/client.js";
import type { DiffToolConfig } from "./external/diff-tool.js";
import type { TortoiseConfig } from "./external/tortoise.js";
import type { ExplorerConfig } from "./external/explorer.js";
import type { ToolContext } from "./tools/context.js";

import * as svnDescribe from "./tools/svn-describe.js";
import * as svnInfo from "./tools/svn-info.js";
import * as svnList from "./tools/svn-list.js";
import * as svnLog from "./tools/svn-log.js";
import * as svnCat from "./tools/svn-cat.js";
import * as svnDiff from "./tools/svn-diff.js";
import * as svnBlame from "./tools/svn-blame.js";
import * as showDiffExternal from "./tools/show-diff-external.js";
import * as showLogTortoise from "./tools/show-log-tortoise.js";
import * as openInExplorer from "./tools/open-in-explorer.js";

interface AppConfig {
  svn: SvnConfig;
  diffTool?: DiffToolConfig;
  tortoise?: TortoiseConfig;
  explorer?: ExplorerConfig;
}

function parseBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v == null || v === "") return defaultValue;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new Error(`真偽値として解釈できません: ${v}`);
}

function readConfig(): AppConfig {
  const repoUrl = process.env.SVN_REPO_URL;
  if (!repoUrl) {
    throw new Error("SVN_REPO_URL が設定されていません。.env を確認してください。");
  }

  const useDocker = parseBool(process.env.SVN_USE_DOCKER, true);
  const composeDir = process.env.SVN_COMPOSE_DIR;
  const dockerService = process.env.SVN_DOCKER_SERVICE || "svn";

  if (useDocker && !composeDir) {
    throw new Error(
      "SVN_USE_DOCKER=true のとき SVN_COMPOSE_DIR の指定が必要です。",
    );
  }

  const timeoutMs = process.env.SVN_TIMEOUT_MS
    ? Number(process.env.SVN_TIMEOUT_MS)
    : 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `SVN_TIMEOUT_MS の値が不正です: ${process.env.SVN_TIMEOUT_MS}`,
    );
  }

  const diffToolPath = process.env.SVN_EXTERNAL_DIFF_TOOL;
  const diffTool: DiffToolConfig | undefined = diffToolPath
    ? { toolPath: diffToolPath }
    : undefined;

  const tortoiseProc = process.env.SVN_TORTOISE_PROC;
  const clientRepoBase = process.env.SVN_REPO_URL_CLIENT;
  const tortoise: TortoiseConfig | undefined = tortoiseProc
    ? { procPath: tortoiseProc, clientRepoBase }
    : undefined;

  const workingCopy = process.env.SVN_WORKING_COPY;
  const explorer: ExplorerConfig | undefined = workingCopy
    ? { workingCopyPath: workingCopy }
    : undefined;

  return {
    svn: {
      repoUrl: repoUrl.replace(/\/+$/, ""),
      useDocker,
      composeDir,
      dockerService,
      timeoutMs,
    },
    diffTool,
    tortoise,
    explorer,
  };
}

async function main() {
  const config = readConfig();
  const svn = new SvnClient(config.svn);
  const ctx: ToolContext = {
    svn,
    diffTool: config.diffTool,
    tortoise: config.tortoise,
    explorer: config.explorer,
  };

  const server = new McpServer({
    name: "svn-mcp",
    version: "0.1.0",
  });

  svnDescribe.register(server, ctx);
  svnInfo.register(server, ctx);
  svnList.register(server, ctx);
  svnLog.register(server, ctx);
  svnCat.register(server, ctx);
  svnDiff.register(server, ctx);
  svnBlame.register(server, ctx);
  showDiffExternal.register(server, ctx);
  showLogTortoise.register(server, ctx);
  openInExplorer.register(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[svn-mcp] started (repo=${config.svn.repoUrl}, docker=${config.svn.useDocker})\n`,
  );
  if (!config.diffTool) {
    process.stderr.write(
      `[svn-mcp] SVN_EXTERNAL_DIFF_TOOL 未設定: show_diff_external は利用不可\n`,
    );
  }
  if (!config.tortoise) {
    process.stderr.write(
      `[svn-mcp] SVN_TORTOISE_PROC 未設定: show_log_tortoise は利用不可\n`,
    );
  }
  if (!config.explorer) {
    process.stderr.write(
      `[svn-mcp] SVN_WORKING_COPY 未設定: open_in_explorer は利用不可\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(
    `[svn-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
