import type { EventRecord, ReplayPage } from "../control-plane/db.js";
import type { DaemonClient } from "../daemon/remote.js";

/**
 * Drains a paginated `attach` or `watch.start` replay stream via `replay.page`,
 * reassembling fragmented large payloads cleanly and stopping immediately if `isClosed()` becomes true.
 */
export async function consumeReplay(
  client: Pick<DaemonClient, "request">,
  first: ReplayPage,
  subscription: { watchId: string } | { attachmentId: string },
  append: (event: EventRecord) => void,
  isClosed: () => boolean = () => false,
): Promise<void> {
  let page: ReplayPage = first;
  const parts: Buffer[] = [];
  while (!isClosed()) {
    for (const event of page.replay ?? []) {
      if (isClosed()) return;
      append(event);
    }
    if (page.fragment) {
      parts.push(Buffer.from(page.fragment.data, "base64"));
      if (page.fragment.final) {
        try {
          const parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
          append({ ...page.fragment.event, payload: parsed });
        } catch {
          append(page.fragment.event);
        }
        parts.length = 0;
      }
    }
    if (!page.next || isClosed()) break;
    page = await client.request<ReplayPage>("replay.page", subscription);
  }
}
