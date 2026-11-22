import type { Readable, Writable } from "node:stream";

export interface FrameReaderOptions {
  maxLineBytes?: number;
  onMessage: (msg: unknown) => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
}

/**
 * Strict LF-delimited NDJSON framing.
 * Avoids Node `readline` because `readline` splits on U+2028/U+2029 inside JSON strings.
 */
export function attachNdjsonReader(stream: Readable, opts: FrameReaderOptions): () => void {
  const maxBytes = opts.maxLineBytes ?? 16 * 1024 * 1024;
  let buf: Buffer = Buffer.alloc(0);
  let discardUntilLf = false;

  const onData = (chunk: Buffer | string) => {
    let piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (discardUntilLf) {
      const nl = piece.indexOf(0x0a);
      if (nl === -1) return;
      piece = piece.subarray(nl + 1);
      discardUntilLf = false;
    }
    buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);

    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > maxBytes) {
          discardUntilLf = true;
          buf = Buffer.alloc(0);
          opts.onError?.(new Error(`NDJSON frame exceeded maxLineBytes (${maxBytes})`));
        }
        break;
      }
      const lineBuf = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (lineBuf.length > maxBytes) {
        opts.onError?.(new Error(`NDJSON frame exceeded maxLineBytes (${maxBytes})`));
        continue;
      }
      const trimmed = lineBuf.toString("utf8").replace(/\r$/, "").trim();
      if (!trimmed) continue;
      try {
        opts.onMessage(JSON.parse(trimmed));
      } catch (err) {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const onEnd = () => {
    if (buf.length > 0) {
      const trimmed = buf.toString("utf8").replace(/\r$/, "").trim();
      buf = Buffer.alloc(0);
      if (trimmed) {
        try {
          opts.onMessage(JSON.parse(trimmed));
        } catch (err) {
          opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
    opts.onEnd?.();
  };

  const onErr = (err: Error) => opts.onError?.(err);

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("error", onErr);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("error", onErr);
  };
}

export function writeNdjson(stream: Writable, msg: unknown): boolean {
  if (stream.destroyed || !stream.writable) return false;
  stream.write(JSON.stringify(msg) + "\n", "utf8");
  return true;
}

// Only outbound daemon messages support fragmentation. Client requests keep their frame limit.
const DAEMON_CHUNK_BYTES = 2 * 1024 * 1024;

export function writeDaemonMessage(stream: Writable, msg: unknown): void {
  if (stream.destroyed || !stream.writable) return;
  const json = JSON.stringify(msg);
  if (Buffer.byteLength(json) <= DAEMON_CHUNK_BYTES) {
    stream.write(json + "\n");
    return;
  }
  const bytes = Buffer.from(json);
  for (let offset = 0; offset < bytes.length; offset += DAEMON_CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + DAEMON_CHUNK_BYTES);
    writeNdjson(stream, { kind: "chunk", data: bytes.subarray(offset, end).toString("base64"), final: end === bytes.length });
  }
}

export function attachDaemonReader(stream: Readable, opts: FrameReaderOptions): () => void {
  const parts: Buffer[] = [];
  return attachNdjsonReader(stream, {
    ...opts,
    onMessage(raw) {
      const frame = raw as { kind?: string; data?: string; final?: boolean } | null;
      if (frame?.kind === "chunk" && typeof frame.data === "string") {
        parts.push(Buffer.from(frame.data, "base64"));
        if (frame.final) {
          const json = Buffer.concat(parts).toString("utf8");
          parts.length = 0;
          opts.onMessage(JSON.parse(json));
        }
      } else {
        opts.onMessage(raw);
      }
    },
  });
}
