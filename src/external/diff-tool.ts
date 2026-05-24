import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SvnClient } from "../svn/client.js";

export interface DiffToolConfig {
  /** WinMerge 等のフルパス。例: C:\Program Files\WinMerge\WinMergeU.exe */
  toolPath: string;
}

export interface LaunchResult {
  leftFile: string;
  rightFile: string;
  tool: string;
  pid?: number;
}

/**
 * 指定2リビジョン × 指定パスのファイルをそれぞれ一時ファイルへ取り出し、
 * 外部差分ツール（WinMerge 等）を起動する。
 *
 * 起動はデタッチ実行で、ツール終了を待たない（MCPサーバはすぐ応答を返す）。
 */
export async function showDiffExternal(
  svn: SvnClient,
  config: DiffToolConfig,
  args: { revisionBefore: number; revisionAfter: number; path: string },
): Promise<LaunchResult> {
  const beforeContent = await svn.cat(args.revisionBefore, args.path);
  const afterContent = await svn.cat(args.revisionAfter, args.path);

  const baseName = path.basename(args.path);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "svn-mcp-diff-"));
  const leftFile = path.join(tmpDir, `r${args.revisionBefore}_${baseName}`);
  const rightFile = path.join(tmpDir, `r${args.revisionAfter}_${baseName}`);

  await fs.writeFile(leftFile, beforeContent, "utf8");
  await fs.writeFile(rightFile, afterContent, "utf8");

  const child = spawn(config.toolPath, [leftFile, rightFile], {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
  });
  child.unref();

  return {
    leftFile,
    rightFile,
    tool: config.toolPath,
    pid: child.pid,
  };
}
