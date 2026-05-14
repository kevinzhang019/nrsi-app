import type { IncomingMessage, ServerResponse } from "node:http";
import { getSnapshot } from "@/lib/pubsub/publisher";
import { PUBSUB_CHANNEL, subscribeToChannel } from "@/lib/pubsub/subscriber";

// SSE port of the (now-deleted) app/api/stream/route.ts. Same wire shape:
//   event: snapshot   — initial array of all current GameStates
//   event: update     — one GameState per watcher publish
//   : ping            — 15s heartbeat to keep proxies awake
//
// Differences from the Vercel version: no 290s pre-timeout (this is a
// long-lived Node process, not a Fluid Compute function), and we write
// straight to `res` instead of a ReadableStream controller.
export async function handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (data: unknown, event?: string) => {
    if (res.writableEnded) return;
    const parts: string[] = [];
    if (event) parts.push(`event: ${event}`);
    parts.push(`data: ${JSON.stringify(data)}`);
    parts.push("", "");
    try {
      res.write(parts.join("\n"));
    } catch {
      /* socket closed mid-write */
    }
  };

  // Hint to EventSource: reconnect after 1s instead of the default 3s.
  try {
    res.write("retry: 1000\n\n");
  } catch {
    return;
  }

  const abort = new AbortController();
  const cleanup = () => {
    if (!abort.signal.aborted) abort.abort();
  };
  req.on("close", cleanup);
  req.on("error", cleanup);

  try {
    const initial = await getSnapshot();
    send({ games: initial }, "snapshot");
  } catch (err) {
    send({ error: `snapshot: ${String(err)}` }, "error");
  }

  const heartbeat = setInterval(() => {
    if (abort.signal.aborted || res.writableEnded) return;
    try {
      res.write(": ping\n\n");
    } catch {
      /* closed */
    }
  }, 15_000);

  try {
    for await (const update of subscribeToChannel(PUBSUB_CHANNEL, abort.signal)) {
      if (abort.signal.aborted) break;
      send(update, "update");
    }
  } catch (err) {
    if (!abort.signal.aborted) send({ error: String(err) }, "error");
  } finally {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* already ended */
    }
  }
}
