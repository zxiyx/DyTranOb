// For an installed package use: import { DyTranObClient, ActionError } from 'dytranob/sdk';
import { DyTranObClient, ActionError } from '../src/sdk.js';

// Run: npm exec tsx examples/sdk.ts
// The token must match the separately running server. This example sends no messages.
const token = process.env.DYTRANOB_TOKEN;
if (!token) throw new Error('Set DYTRANOB_TOKEN to the access token of your running server');
const client = new DyTranObClient({
  baseUrl: process.env.DYTRANOB_URL || 'http://127.0.0.1:5088',
  token,
  timeout: 10000,
});

try {
  console.log('Status:', await client.status());
  console.log('Actions:', (await client.actions()).map(item => item.action));
  client.on('event', event => console.log('Event:', JSON.stringify(event)));
  client.on('transport_error', error => console.error('Transport:', error.message));
  await client.connect();
  console.log('Version via WS:', await client.callWs('get_version_info'));
  console.log('Listening for events; press Ctrl+C to exit.');
} catch (error) {
  client.close();
  if (error instanceof ActionError) console.error(`OneBot error ${error.retcode}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : 'Request failed');
  process.exitCode = 1;
}

process.once('SIGINT', () => client.close());
process.once('SIGTERM', () => client.close());
