import type { ChatEvent } from "../chat-protocol";

/** Reads an NDJSON response body and yields parsed ChatEvents. Malformed lines are skipped. */
export async function* readChatEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): ChatEvent | null => {
    if (!line.trim()) return null;
    try {
      const value = JSON.parse(line) as ChatEvent;
      return value && typeof value === "object" && typeof value.type === "string" ? value : null;
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const event = parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
      }
    }
    const last = parse(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
