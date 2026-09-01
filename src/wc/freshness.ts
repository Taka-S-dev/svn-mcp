import { spawn } from "node:child_process";
import type { SvnClient } from "../svn/client.js";

export interface FreshnessInfo {
  /** WC のベースリビジョン。取得失敗時 null。 */
  wc_revision: number | null;
  /** サーバ HEAD リビジョン。取得失敗時 null。 */
  head_revision: number | null;
  /** true=最新、false=遅れている、null=判定不能。 */
  fresh: boolean | null;
  /** WC が遅れているコミット数。fresh=false 以外は null。 */
  behind_by: number | null;
  /** ユーザ／LLM 向けの警告文。fresh=true なら null。 */
  warning: string | null;
}

/**
 * ホストの svn コマンドを直接 spawn して `svn info <wcPath>` の Revision を取る。
 * Docker 経由ではなくホスト側で svn が必要（TortoiseSVN 等で同梱されていることが多い）。
 * 失敗（svn が無い／WC でない／その他）時は null を返す。
 */
export function getLocalWcRevision(wcPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let resolved = false;
    const finish = (value: number | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("svn", ["info", "--non-interactive", wcPath], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const m = stdout.match(/^Revision:\s*(\d+)/m);
      finish(m ? Number(m[1]) : null);
    });
  });
}

/**
 * WC と HEAD のリビジョンから FreshnessInfo を組み立てる純粋関数。
 * 呼び出し側が既に HEAD を持っているならこちらを使うと余分な svn info を回避できる。
 */
export function buildFreshnessInfo(
  wcRev: number | null,
  headRev: number | null,
): FreshnessInfo {
  if (wcRev === null && headRev === null) {
    return {
      wc_revision: null,
      head_revision: null,
      fresh: null,
      behind_by: null,
      warning:
        "WC と HEAD の両方が取得できませんでした。SVN_WORKING_COPY パスとホストの svn コマンドを確認してください。",
    };
  }
  if (wcRev === null) {
    return {
      wc_revision: null,
      head_revision: headRev,
      fresh: null,
      behind_by: null,
      warning:
        "WC のリビジョン取得に失敗しました（ホストに svn コマンドが必要、または SVN_WORKING_COPY が WC でない可能性）。最新性を判定できないため結果が古い可能性あり。",
    };
  }
  if (headRev === null) {
    return {
      wc_revision: wcRev,
      head_revision: null,
      fresh: null,
      behind_by: null,
      warning: "HEAD リビジョン取得に失敗しました。最新性を判定できません。",
    };
  }

  if (wcRev === headRev) {
    return {
      wc_revision: wcRev,
      head_revision: headRev,
      fresh: true,
      behind_by: 0,
      warning: null,
    };
  }

  const behindBy = headRev - wcRev;
  return {
    wc_revision: wcRev,
    head_revision: headRev,
    fresh: false,
    behind_by: behindBy,
    warning:
      behindBy > 0
        ? `WC は r${wcRev}、HEAD は r${headRev}（${behindBy} コミット遅れ）。最新の変更が反映されていない可能性あり。svn update を検討してください。`
        : `WC は r${wcRev}、HEAD は r${headRev}（WC が HEAD より新しい）。混合リビジョン WC の可能性。`,
  };
}

/**
 * WC と サーバ HEAD の両方を取得して FreshnessInfo を返す convenience 関数。
 * 2 回の svn info（ローカル + リモート）を並列実行。
 */
export async function checkWcFreshness(
  svn: SvnClient,
  wcPath: string,
): Promise<FreshnessInfo> {
  const [wcRev, headInfoText] = await Promise.all([
    getLocalWcRevision(wcPath),
    svn.info().catch(() => null),
  ]);
  const headMatch = headInfoText?.match(/^Revision:\s*(\d+)/m);
  const headRev = headMatch ? Number(headMatch[1]) : null;
  return buildFreshnessInfo(wcRev, headRev);
}
