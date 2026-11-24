import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { DaemonClient } from "../src/daemon/remote.js";

describe("DaemonClient disconnect cleanup", () => {
  it(
    "destroys the local socket on a decoder error without requiring client.close()",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dc-disconnect-"));
      const socketPath = join(root, "d.sock");
      const sockets = new Set<Socket>();

      let resolvePeerClosed!: () => void;
      const peerClosed = new Promise<void>((resolve) => {
        resolvePeerClosed = resolve;
      });

      const server = createServer((sock) => {
        sockets.add(sock);
        sock.once("close", () => {
          sockets.delete(sock);
          resolvePeerClosed();
        });
        let sentMalformed = false;
        sock.on("data", () => {
          if (sentMalformed) return;
          sentMalformed = true;
          sock.write("{not json\n");
        });
      });

      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const client = new DaemonClient(socketPath);
        await client.connect();

        await assert.rejects(
          client.request("ping"),
          (err: unknown) => err instanceof Error && err.message === "Disconnected from harnessd",
        );

        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            peerClosed,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("server did not see client connection close within 2s")),
                2_000,
              );
              timeout.unref?.();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
