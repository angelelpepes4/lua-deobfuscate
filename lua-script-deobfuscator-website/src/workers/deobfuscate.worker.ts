import { deobfuscate } from "../lib/lua/engine";
import { TransformRequest, TransformResponse } from "../lib/lua/protocol";

const workerContext = self as unknown as {
  onmessage: ((event: MessageEvent<TransformRequest>) => void) | null;
  postMessage: (message: TransformResponse) => void;
};

workerContext.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    const result = deobfuscate(data.source, data.options);
    workerContext.postMessage({ id: data.id, result, durationMs: performance.now() - started });
  } catch (error) {
    workerContext.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : "Unexpected Lua processing error",
      durationMs: performance.now() - started,
    });
  }
};