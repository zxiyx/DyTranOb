// For an installed package use: import { Runtime, MockAdapter, startServer } from 'dytranob';
import { Runtime, MockAdapter, startServer } from '../src/index.js';

// Run: npm exec tsx examples/embedded.ts
// Isolated offline runtime: no Douyin login or real messages.
const token = process.env.DYTRANOB_TOKEN;
if (!token) throw new Error('Set DYTRANOB_TOKEN before starting the embedded server');
const runtime = new Runtime({
  dataDir: './data/embedded-example',
  accounts: [{ id: 'example', adapter: new MockAdapter({ accountId: 'example' }) }],
});
runtime.on('diagnostic', item => console.error(item));
await runtime.start();
const server = await startServer(runtime, { host: '127.0.0.1', port: 5089, token });
console.log(`Embedded mock WebUI: http://127.0.0.1:${server.port}`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await runtime.stop();
  await server.close();
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
