import { spawn } from "node:child_process";

export interface SvnConfig {
  /** SVN リポジトリ URL（file:// or https:// 等）。末尾スラッシュは除去。 */
  repoUrl: string;
  /** Docker 経由で svn を実行するか。false ならホストの svn を直接呼ぶ。 */
  useDocker: boolean;
  /** useDocker=true のとき docker compose を実行するディレクトリ。 */
  composeDir?: string;
  /** useDocker=true のとき svn が入っているサービス名（compose のサービス名に合わせる）。 */
  dockerService?: string;
  /** svn コマンドのタイムアウト（ms）。 */
  timeoutMs: number;
}

export class SvnError extends Error {
  constructor(
    message: string,
    public readonly detail: { code: number | null; stderr: string; stdout: string },
  ) {
    super(message);
    this.name = "SvnError";
  }
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

/**
 * 許可されたSVNサブコマンドの集合。読み取り系のみ。
 * リポジトリやワーキングコピーを変更しうるサブコマンド（commit, delete, copy, move,
 * mkdir, import, add, revert, update, merge, lock, propset, mucc 等）は意図的に
 * 含めていない。新しいツールを追加する際もここを起点に判断すること。
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "info",
  "list",
  "ls",
  "log",
  "cat",
  "diff",
  "blame",
  "praise",
  "annotate",
  "stat",
  "status",
  "help",
  "--version",
]);

/**
 * SVN クライアント。
 *
 * Docker モードのときは `docker compose exec -T <service> svn ...` で呼び出す。
 * Direct モードのときはホストの `svn` を直接 spawn する。
 *
 * すべてのメソッドは svn の生の文字列出力を返す。LLM はそのままテキストとして読める。
 */
export class SvnClient {
  constructor(public readonly config: SvnConfig) {}

  /** リポジトリ内パス（例: trunk/src/foo.cpp）を完全 URL に解決する。 */
  resolveUrl(path?: string): string {
    const base = this.config.repoUrl.replace(/\/+$/, "");
    if (!path) return base;
    const cleaned = path.replace(/^\/+/, "");
    return `${base}/${cleaned}`;
  }

  /**
   * svn コマンドを実行して { stdout, stderr } を返す。非0終了時は SvnError。
   *
   * 読み取り系のサブコマンドのみ許可する（READ_ONLY_SUBCOMMANDS 参照）。
   * commit / delete / copy / move 等の破壊的サブコマンドはここで弾く。
   */
  async execSvn(args: string[]): Promise<SpawnResult> {
    const subcommand = args[0];
    if (!subcommand || !READ_ONLY_SUBCOMMANDS.has(subcommand)) {
      throw new SvnError(
        `svn-mcp は読み取り専用です。サブコマンド '${subcommand ?? "(空)"}' は許可されていません。` +
          `許可済み: ${[...READ_ONLY_SUBCOMMANDS].join(", ")}`,
        { code: null, stderr: "", stdout: "" },
      );
    }
    const { command, fullArgs } = this.buildCommand(args);
    return spawnAsync(command, fullArgs, {
      cwd: this.config.useDocker ? this.config.composeDir : undefined,
      timeoutMs: this.config.timeoutMs,
    });
  }

  private buildCommand(svnArgs: string[]): { command: string; fullArgs: string[] } {
    if (this.config.useDocker) {
      const service = this.config.dockerService;
      if (!service) {
        throw new Error(
          "SVN_USE_DOCKER=true のとき SVN_DOCKER_SERVICE が必要です。",
        );
      }
      return {
        command: "docker",
        fullArgs: ["compose", "exec", "-T", service, "svn", ...svnArgs],
      };
    }
    return { command: "svn", fullArgs: svnArgs };
  }

  // ===== 高レベル API =====

  async info(path?: string): Promise<string> {
    const r = await this.execSvn(["info", this.resolveUrl(path)]);
    return r.stdout;
  }

  async list(
    path?: string,
    opts: { recursive?: boolean } = {},
  ): Promise<string> {
    const args = ["list"];
    if (opts.recursive) args.push("-R");
    args.push(this.resolveUrl(path));
    const r = await this.execSvn(args);
    return r.stdout;
  }

  async log(
    path?: string,
    opts: {
      limit?: number;
      verbose?: boolean;
      fromRev?: number | string;
      toRev?: number | string;
    } = {},
  ): Promise<string> {
    const args = ["log"];
    if (opts.limit) args.push("--limit", String(opts.limit));
    if (opts.verbose) args.push("-v");
    if (opts.fromRev != null || opts.toRev != null) {
      const from = opts.fromRev ?? 1;
      const to = opts.toRev ?? "HEAD";
      args.push("-r", `${from}:${to}`);
    }
    args.push(this.resolveUrl(path));
    const r = await this.execSvn(args);
    return r.stdout;
  }

  async cat(revision: number | "HEAD", path: string): Promise<string> {
    const args = ["cat", "-r", String(revision), this.resolveUrl(path)];
    const r = await this.execSvn(args);
    return r.stdout;
  }

  /**
   * 指定パスについて行ごとに「最後に変更したリビジョン・著者」を返す。
   * revision を指定するとその時点での blame、省略時は HEAD。
   */
  async blame(
    path: string,
    opts: { revision?: number | "HEAD" } = {},
  ): Promise<string> {
    const args = ["blame"];
    if (opts.revision != null) {
      args.push("-r", String(opts.revision));
    }
    args.push(this.resolveUrl(path));
    const r = await this.execSvn(args);
    return r.stdout;
  }

  /**
   * 差分を取得する。指定方法は3通り:
   *  - changeRev のみ: 単一リビジョンの差分（svn diff -c REV）
   *  - fromRev + toRev: 範囲の差分（svn diff -r FROM:TO）
   *  - changeRev も範囲も無指定: working copy の差分（通常 Docker 経由では使わない）
   */
  async diff(opts: {
    changeRev?: number;
    fromRev?: number;
    toRev?: number | "HEAD";
    path?: string;
  }): Promise<string> {
    const args = ["diff"];
    if (opts.changeRev != null) {
      args.push("-c", String(opts.changeRev));
    } else if (opts.fromRev != null && opts.toRev != null) {
      args.push("-r", `${opts.fromRev}:${opts.toRev}`);
    }
    args.push(this.resolveUrl(opts.path));
    const r = await this.execSvn(args);
    return r.stdout;
  }
}

// ---------- spawn helper ----------

interface SpawnOpts {
  cwd?: string;
  timeoutMs: number;
}

function spawnAsync(
  command: string,
  args: string[],
  opts: SpawnOpts,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new SvnError(`コマンド起動失敗: ${command} (${err.message})`, {
          code: null,
          stderr: err.message,
          stdout: "",
        }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new SvnError(
            `svn コマンドが ${opts.timeoutMs}ms でタイムアウトしました。`,
            { code, stderr, stdout },
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new SvnError(
            `svn が exit code ${code} で失敗しました: ${stderr.trim() || "(stderr 空)"}`,
            { code, stderr, stdout },
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
