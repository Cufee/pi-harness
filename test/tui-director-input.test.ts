import { describe, expect, spyOn, test } from "bun:test";
import { ProcessTerminal, type TUI } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import { Composer, createTheme } from "../src/tui/primitives/index.js";

// Replace only terminal I/O and daemon transport. Keys still go through pi-tui,
// TerminalSession's controls, the focused composer and the Director chat loop.
async function openChat() {
  const ready = Promise.withResolvers<(key: string) => void>();
  const start = spyOn(ProcessTerminal.prototype, "start").mockImplementation(function (this: ProcessTerminal, input) {
    Object.assign(this, { write() {}, hideCursor() {}, showCursor() {}, stop() {}, async drainInput() {} });
    ready.resolve(input);
  });
  const session = { id: "chat-input", title: "Input", repoRoot: "/fixture", profileId: "pi:local" };
  let emit!: (event: DaemonEventFrame) => void;
  const requests: Array<{ op: string; params: Record<string, string> } & PromiseWithResolvers<unknown>> = [];
  const client = {
    onEvent(listener: typeof emit) { emit = listener; return () => {}; },
    onClose: () => () => {},
    close() {},
    request(op: string, params: Record<string, string>) {
      if (op === "chat.open") return { session, goals: [], history: [], config: {}, activeTurnId: null };
      if (op === "goal.list") return [];
      if (op === "session.leave") return { daemonWillQuit: true };
      const pending = Promise.withResolvers<unknown>();
      requests.push({ op, params, ...pending });
      return pending.promise;
    },
  } as unknown as DaemonClient;
  const status = process.env.PI_PROGRAM_STATUS;
  const done = runDirectorChatTui({ client, repoRoot: session.repoRoot });
  let key: (data: string) => void;
  try {
    key = await Promise.race([ready.promise, done.then(() => { throw new Error("Chat exited before startup"); })]);
  } finally {
    start.mockRestore();
    if (status === undefined) delete process.env.PI_PROGRAM_STATUS;
    else process.env.PI_PROGRAM_STATUS = status;
  }
  const submit = (text: string) => { for (const char of text) key(char); key("\r"); };
  const enqueue = (text: string, bind: "ctrl+q" | "alt+enter" = "ctrl+q") => {
    for (const char of text) key(char);
    key(bind === "alt+enter" ? "\x1b\r" : "\x11");
  };
  return {
    key, submit, enqueue, requests,
    sends: () => requests.filter(r => r.op === "chat.send").map(r => r.params.text),
    end(turnId: string) {
      emit({ kind: "event", seq: 1, runId: "", taskId: null, createdAt: 0, type: "chat.turn.end",
        payload: { chatSessionId: session.id, turnId, cancelled: true } });
    },
    async close() { key("\x1d"); await done; },
  };
}

describe("Director chat input", () => {
  test("Enter while busy sends immediately to Director by default; Ctrl+Q and Alt+Enter explicitly enqueue", async () => {
    const chat = await openChat();
    try {
      chat.submit("active");
      // Default Enter while busy immediately sends via chat.steer (not queued)
      chat.submit("urgent");
      const [active, steer] = chat.requests;
      expect(steer?.op).toBe("chat.steer");
      expect(steer!.params).toEqual({ chatSessionId: "chat-input", turnId: active!.params.turnId!, message: "urgent" });
      steer!.resolve({ steered: true });
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active"]);

      // Explicit Ctrl+Q and Alt+Enter enqueue FIFO without interrupting active turn
      chat.enqueue("queued-1", "ctrl+q");
      chat.enqueue("queued-2", "alt+enter");
      expect(chat.requests.length).toBe(2);
      active!.resolve({});
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "queued-1"]);
      chat.requests[2]!.resolve({});
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "queued-1", "queued-2"]);
    } finally { await chat.close(); }
  });

  test("Esc requires double-press confirmation (typing another key disarms without stopping), then drains queue FIFO", async () => {
    const chat = await openChat();
    try {
      chat.submit("active");
      chat.enqueue("first");
      chat.enqueue("second");
      // First Esc only arms confirmation — must NOT cancel yet!
      chat.key("\x1b");
      expect(chat.requests.length).toBe(1);
      // Typing another key disarms confirmation without cancelling
      chat.key("a");
      chat.key("\x7f");
      expect(chat.requests.length).toBe(1);
      // Now press Esc twice to confirm stop
      chat.key("\x1b");
      expect(chat.requests.length).toBe(1);
      chat.key("\x1b");
      const [active, cancel] = chat.requests;
      expect(cancel?.op).toBe("chat.cancel");
      expect(cancel!.params.turnId).toBe(active!.params.turnId!);
      chat.end(active!.params.turnId!);
      expect(chat.sends()).toEqual(["active"]);
      cancel!.resolve({ cancelled: true });
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "first"]);
      active!.resolve({ cancelled: true }); // Late reply must not settle the new turn.
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "first"]);
      chat.requests[2]!.resolve({});
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "first", "second"]);
    } finally { await chat.close(); }
  });

  test("Composer Esc confirmation replaces input with shrinking progress bar at exact same height (zero UI jump)", () => {
    const fakeTui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
    const theme = createTheme();
    const composer = new Composer(fakeTui, theme, { placeholder: "Message Director…" });
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    for (const draft of ["", "single line draft", "line one\nline two\nline three"]) {
      composer.setText(draft);
      for (const width of [48, 80, 120]) {
        const normalLines = composer.render(width);
        composer.setConfirmBanner({ text: "Press Esc again to stop Director", progress: 1 });
        const fullLines = composer.render(width);
        composer.setConfirmBanner({ text: "Press Esc again to stop Director", progress: 0.4 });
        const midLines = composer.render(width);
        composer.clearConfirmBanner();
        const restoredLines = composer.render(width);

        expect(fullLines.length).toBe(normalLines.length);
        expect(midLines.length).toBe(normalLines.length);
        expect(restoredLines.length).toBe(normalLines.length);
        // Progress line shrinks monotonically
        const fullBarCount = (strip(fullLines[0]!).match(/━/g) ?? []).length;
        const midBarCount = (strip(midLines[0]!).match(/━/g) ?? []).length;
        expect(fullBarCount).toBe(width);
        expect(midBarCount).toBeLessThan(fullBarCount);
        expect(midBarCount).toBeGreaterThan(0);
        expect(strip(midLines[1]!)).toContain("Press Esc again to stop Director");
      }
    }
  });

  for (const native of [true, false]) {
    test(`Enter ${native ? "steers the active turn" : "falls back to stop and send"} without losing queued input`, async () => {
      const chat = await openChat();
      try {
        chat.submit("active");
        chat.enqueue("first");
        chat.enqueue("second");
        chat.submit("!"); // Enter sends draft immediately, ahead of queued messages.
        const [active, steer] = chat.requests;
        expect(steer?.op).toBe("chat.steer");
        expect(steer!.params).toEqual({ chatSessionId: "chat-input", turnId: active!.params.turnId!, message: "!" });
        steer!.resolve({ steered: native, cancelled: !native });
        await Promise.resolve();
        const prefix = native ? ["active"] : ["active", "!"];
        expect(chat.sends()).toEqual(prefix);
        (native ? active! : chat.requests.at(-1)!).resolve({});
        await Promise.resolve();
        expect(chat.sends()).toEqual([...prefix, "first"]);
        chat.requests.at(-1)!.resolve({});
        await Promise.resolve();
        expect(chat.sends()).toEqual([...prefix, "first", "second"]);
      } finally { await chat.close(); }
    });
  }

  test("steering the queue head during settlement consumes it only on acceptance", async () => {
    const chat = await openChat();
    try {
      chat.submit("active");
      chat.enqueue("first");
      chat.enqueue("second");
      chat.key("\x13");
      const [active, steer] = chat.requests;
      expect(steer?.op).toBe("chat.steer");
      expect(steer!.params.message).toBe("first");
      active!.resolve({});
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active"]);
      steer!.resolve({ steered: true });
      await Promise.resolve();
      expect(chat.sends()).toEqual(["active", "second"]);
    } finally { await chat.close(); }
  });

  for (const cause of ["send error", "Ctrl+C"]) {
    test(`${cause} recalls the queue into editable input instead of auto-sending`, async () => {
      const chat = await openChat();
      try {
        chat.submit("active");
        chat.enqueue("first");
        chat.enqueue("second");
        const active = chat.requests[0]!;
        if (cause === "Ctrl+C") {
          chat.key("\x03");
          expect(chat.requests[1]?.op).toBe("chat.cancel");
          chat.end(active.params.turnId!);
          chat.requests[1]!.resolve({ cancelled: true });
        } else {
          chat.key("x"); // Preserve pre-existing input after the recalled messages.
          active.reject(new Error("fixture failure"));
        }
        await Promise.resolve();
        expect(chat.sends()).toEqual(["active"]);
        chat.submit("!");
        expect(chat.sends()).toEqual(["active", `first\n\nsecond${cause === "send error" ? "\n\nx" : ""}!`]);
      } finally { await chat.close(); }
    });
  }
});
