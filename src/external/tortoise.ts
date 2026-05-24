import { spawn } from "node:child_process";

export interface TortoiseConfig {
  /** TortoiseProc.exe のフルパス。例: C:\Program Files\TortoiseSVN\bin\TortoiseProc.exe */
  procPath: string;
  /**
   * TortoiseSVN から見たリポジトリのベース URL、または作業コピーの絶対パス。
   * 例: https://svn.example.com/repo / svn+ssh://host/repo / C:\path\to\wc
   *
   * 未設定なら svn 実行用の URL（SvnConfig.repoUrl）をそのまま使う。
   * Docker 内 file:// URL のように Windows ホストから見えないパスを使っている場合、
   * ここで Windows から到達可能な URL/パスを別途指定する。
   */
  clientRepoBase?: string;
}

export interface LogLaunchResult {
  tool: string;
  pid?: number;
  /** TortoiseProc に渡した /path: の値（デバッグ用） */
  targetPath: string;
}

/**
 * TortoiseProc.exe を `/command:log` で起動し、指定パスのログダイアログを開く。
 * デタッチ実行で、ツール終了を待たない。
 */
export function showLogInTortoise(
  config: TortoiseConfig,
  fallbackBaseUrl: string,
  args: { path?: string },
): LogLaunchResult {
  const base = config.clientRepoBase ?? fallbackBaseUrl;
  const targetPath = joinSvnPath(base, args.path);
  const child = spawn(
    config.procPath,
    ["/command:log", `/path:${targetPath}`, "/closeonend:0"],
    {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
    },
  );
  child.unref();
  return { tool: config.procPath, pid: child.pid, targetPath };
}

function joinSvnPath(base: string, path?: string): string {
  const cleanBase = base.replace(/[/\\]+$/, "");
  if (!path) return cleanBase;
  const cleanPath = path.replace(/^[/\\]+/, "");
  return `${cleanBase}/${cleanPath}`;
}
