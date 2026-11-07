import type { StreamEvent } from '../api/types';

/** Incremental SSE reader: feed raw chunks, get `data:` payloads out. `event: error` marks the next payload as an error. */
export class SseParser {
  private buf = '';
  private nextIsError = false;

  push(chunk: string): Array<{ data: StreamEvent | 'DONE'; error: boolean }> {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    const out: Array<{ data: StreamEvent | 'DONE'; error: boolean }> = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('event: ')) {
        if (line.slice(7).trim() === 'error') this.nextIsError = true;
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      const error = this.nextIsError;
      this.nextIsError = false;
      if (payload === '[DONE]') {
        out.push({ data: 'DONE', error });
        continue;
      }
      try {
        out.push({ data: JSON.parse(payload) as StreamEvent, error });
      } catch {
        // Non-JSON payloads are ignored, as in the vanilla reader.
      }
    }
    return out;
  }
}
