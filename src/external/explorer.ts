import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";

export interface ExplorerConfig {
  /** 作業コピー（ローカル WC）の絶対パス（Windows）。例: C:\path\to\wc */
  workingCopyPath: string;
}

export interface ExplorerLaunchResult {
  tool: string;
  pid?: number;
  /** explorer.exe に渡したターゲットパス */
  targetPath: string;
  /** /select, で親フォルダ＋ファイル選択モードを使ったか */
  selected: boolean;
}

/**
 * 指定パスを Windows エクスプローラで開く。デタッチ実行。
 *
 * ファイルの場合: `explorer.exe /select,<file>` で親フォルダを開いてファイルをハイライト。
 * フォルダの場合: `explorer.exe <folder>` でそのフォルダを開く。
 * 存在しない場合: そのまま `<path>` を渡す（Explorer 側でエラー表示）。
 */
export function openInExplorer(
  config: ExplorerConfig,
  args: { path?: string },
): ExplorerLaunchResult {
  const cleanRel = (args.path ?? "")
    .replace(/[/\\]+/g, path.sep)
    .replace(new RegExp(`^${path.sep === "\\" ? "\\\\" : "/"}+`), "");
  const targetPath = cleanRel
    ? path.join(config.workingCopyPath, cleanRel)
    : config.workingCopyPath;

  const stat = statSync(targetPath, { throwIfNoEntry: false });
  const selected = stat?.isFile() ?? false;

  const spawnArgs = selected ? [`/select,${targetPath}`] : [targetPath];
  const child = spawn("explorer.exe", spawnArgs, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
  });
  child.unref();

  return { tool: "explorer.exe", pid: child.pid, targetPath, selected };
}
