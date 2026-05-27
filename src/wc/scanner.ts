import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * バイナリの可能性が高い拡張子。grep 対象から早めに弾く。
 */
const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".a", ".lib", ".bin",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".jar", ".war",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flv",
  ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".class", ".pyc", ".pyo",
]);

export interface WalkOptions {
  /** WC ルートからの相対パス。省略時は WC ルート全体。 */
  base?: string;
  /** ファイル発見時のコールバック。true を返すと探索を即停止。 */
  onFile?: (relPath: string, absPath: string) => Promise<boolean> | boolean;
}

export interface WalkResult {
  scanned: number;
  stopped: boolean;
}

/**
 * WC を再帰的に walk する。.svn ディレクトリは自動スキップ。
 * 各ファイルで onFile を呼ぶ。エラーは無視（権限不足等）。
 */
export async function walkWc(
  wcRoot: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const startAbs = options.base
    ? path.join(wcRoot, options.base.replace(/[/\\]+/g, path.sep))
    : wcRoot;
  let scanned = 0;
  let stopped = false;

  async function walk(absPath: string, relPath: string): Promise<void> {
    if (stopped) return;
    let entries;
    try {
      entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped) return;
      if (entry.name === ".svn") continue;
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const childAbs = path.join(absPath, entry.name);

      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        scanned++;
        if (options.onFile) {
          try {
            const shouldStop = await options.onFile(childRel, childAbs);
            if (shouldStop) {
              stopped = true;
              return;
            }
          } catch {
            // 個別ファイル処理エラーは無視
          }
        }
      }
    }
  }

  await walk(startAbs, options.base ?? "");
  return { scanned, stopped };
}

/**
 * 拡張子からバイナリの可能性を判定（grep のプリフィルタ用）。
 */
export function isLikelyBinaryByExt(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * ファイル先頭バイトに NUL が含まれていれば確実にバイナリと判定。
 */
export async function hasNullByte(absPath: string, sampleSize = 512): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(absPath, "r");
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buf, 0, sampleSize, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true; // 読めなければ安全側に倒してバイナリ扱い
  } finally {
    await handle?.close();
  }
}
