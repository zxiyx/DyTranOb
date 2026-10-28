export interface ActionRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: unknown;
  self_id?: number;
  account_id?: string;
}

export interface ActionResponse<T = unknown> {
  status: 'ok' | 'failed';
  retcode: number;
  data: T | null;
  message?: string;
  wording?: string;
  echo?: unknown;
}

export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OneBotEvent extends Record<string, unknown> {
  time: number;
  self_id: number;
  post_type: 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event';
}

export class ActionFault extends Error {
  constructor(public readonly retcode: number, message: string) { super(message); }
}

export interface ActionDefinition {
  action: string;
  description: string;
  params: Record<string, unknown>;
}
