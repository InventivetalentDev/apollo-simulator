import { assembleSources, transferables, type AssembleRequest } from './assemble-sources.ts';

self.onmessage = (e: MessageEvent<AssembleRequest>) => {
  try {
    const response = assembleSources(e.data);
    (self as unknown as Worker).postMessage({ ok: true, response }, transferables(response.result));
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
