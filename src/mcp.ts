import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ActionError, type DyTranObClient } from './sdk.js';
import { EXTENSION_READ_ACTIONS, EXTENSION_WRITE_ACTIONS } from './extensions.js';

export const READ_ACTIONS = [
  ...EXTENSION_READ_ACTIONS,
  'get_version_info', 'get_status', 'get_login_info', 'get_friend_list', 'get_group_list',
  'get_group_info', 'get_group_member_list', 'get_group_member_info', 'get_stranger_info', 'get_msg',
  'can_send_image', 'can_send_record', 'dy_list_accounts', 'dy_get_capabilities', 'dy_get_native_id', 'dy_resolve_id',
] as const;
export const WRITE_ACTIONS = [
  ...EXTENSION_WRITE_ACTIONS,
  'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'set_group_name', 'set_group_leave',
  'set_group_kick', 'set_friend_add_request', 'set_group_add_request',
] as const;

const selector = {
  account_id: z.string().min(1).max(64).optional(),
  self_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
};
const readSchema = z.object({ action: z.enum(READ_ACTIONS), params: z.record(z.string(), z.unknown()).default({}), ...selector }).strict();
const writeSchema = z.object({ action: z.enum(WRITE_ACTIONS), params: z.record(z.string(), z.unknown()), ...selector }).strict();
const idSchema = z.object({ kind: z.enum(['user', 'group', 'message']), native_id: z.string().min(1).max(10000), ...selector }).strict();
const eventSchema = z.object({ limit: z.number().int().min(0).max(1000).default(100) }).strict();
const emptySchema = z.object({}).strict();
const selectorProperties = {
  account_id: { type: 'string' as const, description: 'Configured account ID; required when multiple accounts exist.' },
  self_id: { type: 'integer' as const, minimum: 1, description: 'Alternative OneBot account ID.' },
};

type McpClient = Pick<DyTranObClient, 'status' | 'actions' | 'recentEvents' | 'call'>;

/** Create an MCP server. Caller selects stdio or another official SDK transport. */
export function createMcpServer(client: McpClient, options: { allowWrite?: boolean } = {}): Server {
  const server = new Server({ name: 'dytranob', version: '0.1.0' }, { capabilities: { tools: {} } });
  const tools = [
    {
      name: 'douyin_status', description: 'Read the runtime status and configured account availability.',
      inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'douyin_actions', description: 'List runtime OneBot actions, their descriptions and parameter schemas. Listed actions may depend on native adapter capabilities.',
      inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'douyin_events', description: 'Read recent local OneBot event history.',
      inputSchema: { type: 'object' as const, properties: { limit: { type: 'integer' as const, minimum: 0, maximum: 1000, default: 100 } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'douyin_query', description: 'Run an allowlisted read action. dy_resolve_id only stores local ID metadata and never sends a message. Native user, group and message IDs are strings; use dy_resolve_id before passing a OneBot numeric ID.',
      inputSchema: { type: 'object' as const, properties: { action: { type: 'string' as const, enum: [...READ_ACTIONS] }, params: { type: 'object' as const, additionalProperties: true, default: {} }, ...selectorProperties }, required: ['action'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: 'douyin_resolve_id', description: 'Map a native string ID to a stable local OneBot integer. Creates local metadata only; never sends a message.',
      inputSchema: { type: 'object' as const, properties: { kind: { type: 'string' as const, enum: ['user', 'group', 'message'] }, native_id: { type: 'string' as const }, ...selectorProperties }, required: ['kind', 'native_id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ...(options.allowWrite ? [{
      name: 'douyin_write', description: 'Perform an explicitly enabled message or moderation action. Check account, target and message carefully; actions affect the actual Douyin account.',
      inputSchema: { type: 'object' as const, properties: { action: { type: 'string' as const, enum: [...WRITE_ACTIONS] }, params: { type: 'object' as const, additionalProperties: true }, ...selectorProperties }, required: ['action', 'params'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }] : []),
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      let result: unknown;
      const args = request.params.arguments ?? {};
      switch (request.params.name) {
        case 'douyin_status': emptySchema.parse(args); result = await client.status(); break;
        case 'douyin_actions': emptySchema.parse(args); result = await client.actions(); break;
        case 'douyin_events': result = await client.recentEvents(eventSchema.parse(args).limit); break;
        case 'douyin_query': {
          const { action, params, ...account } = readSchema.parse(args);
          result = await client.call(action, params, account); break;
        }
        case 'douyin_resolve_id': {
          const { kind, native_id, ...account } = idSchema.parse(args);
          result = await client.call('dy_resolve_id', { kind, native_id }, account); break;
        }
        case 'douyin_write': {
          if (!options.allowWrite) throw new Error('Write tools are disabled');
          const { action, params, ...account } = writeSchema.parse(args);
          result = await client.call(action, params, account); break;
        }
        default: throw new Error('Unknown tool');
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? 'null' }] };
    } catch (error) {
      // Do not return fetch errors, request headers, server URLs, cookies or access tokens to an MCP peer.
      const message = error instanceof ActionError ? `OneBot action failed (${error.retcode})` : error instanceof z.ZodError ? 'Invalid tool arguments' : error instanceof Error && ['Write tools are disabled', 'Unknown tool'].includes(error.message) ? error.message : 'Runtime request failed';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
  return server;
}
