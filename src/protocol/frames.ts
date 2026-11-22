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

  const onData = (chunk: Buffer | string) => {
    const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);

    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > maxBytes) {
          buf = Buffer.alloc(0);
          opts.onError?.(new Error(`NDJSON frame exceeded maxLineBytes (${maxBytes})`));
        }
        break;
      }
      const lineBuf = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
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
  return stream.write(JSON.stringify(msg) + "\n", "utf8");
}
