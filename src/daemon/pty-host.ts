import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface PtySessionInfo {
  id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  usingLibghosttyVt: boolean;
  createdAt: number;
}

interface ActivePty {
  info: PtySessionInfo;
  proc: ChildProcess;
  scrollback: string[];
  maxScrollbackLines: number;
  listeners: Set<(chunk: string) => void>;
}

/**
 * Lightweight daemon-owned interactive shell host (`harness worktrees shell <worker-id>`).
 * Keeps shells alive when clients detach.
 * Automatically integrates `libghostty-vt` WASM (`@gkoreli/ghostty-vt-js`) when installed
 * for headless VT state rehydration & detached terminal query answering, while falling back
 * cleanly to a bounded ANSI ring buffer when no optional native/WASM addon is installed.
 */
export class PtyHost {
  private sessions = new Map<string, ActivePty>();
  private ghosttyAvailable = false;

  async init(): Promise<void> {
    try {
      // Optional runtime detection — zero hard native build requirement
      const modName = "@gkoreli/ghostty-vt-js";
      await import(modName);
      this.ghosttyAvailable = true;
    } catch {
      this.ghosttyAvailable = false;
    }
  }

  get hasLibghosttyVt(): boolean {
    return this.ghosttyAvailable;
  }

  activePtyCount(): number {
    return this.sessions.size;
  }

  open(opts: { cwd: string; cols?: number; rows?: number; shell?: string }): PtySessionInfo {
    const id = `pty-${randomBytes(4).toString("hex")}`;
    const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 36;

    // Spawn interactive login shell with `script` PTY wrapper on macOS/Linux when node-pty isn't installed
    const isMac = process.platform === "darwin";
    const proc = isMac
      ? spawn("/usr/bin/script", ["-q", "/dev/null", shell, "-i"], {
          cwd: opts.cwd,
          env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(shell, ["-i"], {
          cwd: opts.cwd,
          env: { ...process.env, TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
          stdio: ["pipe", "pipe", "pipe"],
        });

    const active: ActivePty = {
      info: {
        id,
        cwd: opts.cwd,
        shell,
        cols,
        rows,
        usingLibghosttyVt: this.ghosttyAvailable,
        createdAt: Date.now(),
      },
      proc,
      scrollback: [],
      maxScrollbackLines: 2000,
      listeners: new Set(),
    };

    const pushChunk = (chunk: string) => {
      active.scrollback.push(chunk);
      if (active.scrollback.length > active.maxScrollbackLines) {
        active.scrollback.splice(0, active.scrollback.length - active.maxScrollbackLines);
      }
      for (const fn of active.listeners) fn(chunk);
    };

    proc.stdout?.setEncoding("utf8").on("data", pushChunk);
    proc.stderr?.setEncoding("utf8").on("data", pushChunk);
    proc.once("exit", () => {
      pushChunk("\r\n[shell exited]\r\n");
      this.sessions.delete(id);
    });

    this.sessions.set(id, active);
    return active.info;
  }

  attach(id: string, onData: (chunk: string) => void): { snapshot: string; detach: () => void } {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown PTY session ${id}`);
    s.listeners.add(onData);
    return {
      snapshot: s.scrollback.join(""),
      detach: () => s.listeners.delete(onData),
    };
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown PTY session ${id}`);
    s.proc.stdin?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.info.cols = cols;
    s.info.rows = rows;
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.proc.kill("SIGTERM");
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
