/* global process */
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let hostRequestId;
let sequence = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: 'pilion-acp-draft-1', handshakeSecret: process.env.PILION_ACP_DRAFT_HANDSHAKE_SECRET },
    });
    return;
  }
  if (message.method === 'agent/task' && message.id !== undefined) {
    hostRequestId = message.id;
    sequence += 1;
    send({ jsonrpc: '2.0', id: `observe-${sequence}`, method: 'browser/tool', params: {
      requestId: `e2e-observe-${sequence}`, name: 'browser.observe', args: {},
    } });
    return;
  }
  if (typeof message.id === 'string' && message.id.startsWith('observe-') && message.result) {
    const elementRef = message.result.elements?.[0]?.ref;
    if (!elementRef) {
      send({ jsonrpc: '2.0', id: hostRequestId, result: { ok: false, reason: 'no interactive element' } });
      return;
    }
    send({ jsonrpc: '2.0', id: `click-${sequence}`, method: 'browser/tool', params: {
      requestId: `e2e-click-${sequence}`, name: 'browser.click', args: { elementRef },
    } });
    return;
  }
  if (typeof message.id === 'string' && message.id.startsWith('click-')) {
    send({ jsonrpc: '2.0', id: hostRequestId, result: {
      ok: !message.error, stale: message.error?.data?.code === 'STALE_ELEMENT', toolResponse: message,
    } });
  }
});
