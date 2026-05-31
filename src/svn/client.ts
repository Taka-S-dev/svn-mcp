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
  /**
   * リポジトリのルート URL（svn info の Repository Root）。
   * 初回必要時に lazy-load してキャッシュ。'/' 始まりの絶対パスを解決するのに使う。
   */
  private repositoryRoot: string | null = null;

  constructor(public readonly config: SvnConfig) {}

  /**
   * Repository Root をキャッシュ済みなら返し、未取得なら svn info を叩いて取得＋キャッシュ。
   *
   * 呼び出し側が既に svn info の出力を持っていれば `infoText` に渡すと
   * 余分な svn info 呼び出しをスキップする（svn_describe のような既取得ケース最適化）。
   */
  async getRepositoryRoot(infoText?: string): Promise<string> {
    if (this.repositoryRoot) return this.repositoryRoot;
    const text =
      infoText ??
      (await this.execSvn(["info", this.config.repoUrl.replace(/\/+$/, "")]))
        .stdout;
    const m = text.match(/^Repository Root:\s*(\S+)/m);
    if (!m) {
      throw new SvnError(
        "Failed to extract 'Repository Root' from svn info output.",
        { code: null, stderr: "", stdout: text },
      );
    }
    this.repositoryRoot = m[1].replace(/\/+$/, "");
    return this.repositoryRoot;
  }

  /**
   * リポジトリ内パスを完全 URL に解決する。
   *
   * - path 省略: SVN_REPO_URL をそのまま返す
   * - '/' 始まり: リポジトリルート起点の絶対パスとして解決（Repository Root + path）
   *   例: '/branches/release-1.0/foo.c' → '<repo-root>/branches/release-1.0/foo.c'
   *   svn log -v の "Changed paths" 出力をそのまま渡せる
   * - それ以外: SVN_REPO_URL 起点の相対パスとして解決
   *   例: 'extend/foo.c' → '<SVN_REPO_URL>/extend/foo.c'
   */
  async resolveUrl(path?: string): Promise<string> {
    const base = this.config.repoUrl.replace(/\/+$/, "");
    if (!path) return base;
    if (path.startsWith("/")) {
      const root = (await this.getRepositoryRoot()).replace(/\/+$/, "");
      return root + path;
    }
    return `${base}/${path}`;
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
    const url = await this.resolveUrl(path);
    const r = await this.execSvn(["info", url]);
    return r.stdout;
  }

  async list(
    path?: string,
    opts: { recursive?: boolean } = {},
  ): Promise<string> {
    const args = ["list"];
    if (opts.recursive) args.push("-R");
    args.push(await this.resolveUrl(path));
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
      /** YYYY-MM-DD。fromRev/toRev とは排他（呼び出し側でバリデーション）。 */
      fromDate?: string;
      toDate?: string;
      /** svn log --search のパターン。コミットメッセージ・著者・パスを部分一致検索。 */
      messageContains?: string;
    } = {},
  ): Promise<string> {
    const args = ["log"];
    if (opts.limit) args.push("--limit", String(opts.limit));
    if (opts.verbose) args.push("-v");

    if (opts.fromRev != null || opts.toRev != null) {
      const from = opts.fromRev ?? 1;
      const to = opts.toRev ?? "HEAD";
      args.push("-r", `${from}:${to}`);
    } else if (opts.fromDate || opts.toDate) {
      const from = opts.fromDate ? `{${opts.fromDate}}` : "1";
      const to = opts.toDate ? `{${opts.toDate}}` : "HEAD";
      args.push("-r", `${from}:${to}`);
    }

    if (opts.messageContains) {
      args.push("--search", opts.messageContains);
    }

    args.push(await this.resolveUrl(path));
    const r = await this.execSvn(args);
    return r.stdout;
  }

  async cat(revision: number | "HEAD", path: string): Promise<string> {
    const url = await this.resolveUrl(path);
    const args = ["cat", "-r", String(revision), url];
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
    args.push(await this.resolveUrl(path));
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
    args.push(await this.resolveUrl(opts.path));
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
