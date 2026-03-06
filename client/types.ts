/**
 * Client-side type definitions for Claude Agent Bridge.
 * These types mirror the SSE event types from the server.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  sdkSessionId?: string;
  name: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  status: 'idle' | 'busy' | 'closed';
  createdAt: number;
  lastActiveAt: number;
  queryCount: number;
  totalCostUsd: number;
  history: HistoryEntry[];
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  costUsd?: number;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

// ---------------------------------------------------------------------------
// SSE Events (received from server)
// ---------------------------------------------------------------------------

export type SSEEventType =
  | 'session_init'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'stream_delta'
  | 'result'
  | 'error';

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: number;
}

// Typed event data
export interface TextEventData {
  text: string;
}

export interface ThinkingEventData {
  thinking: string;
}

export interface ToolUseEventData {
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface ToolResultEventData {
  toolId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
}

export interface ResultEventData {
  subtype: string;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  sessionId?: string;
  isError?: boolean;
}

export interface ErrorEventData {
  message: string;
}

// ---------------------------------------------------------------------------
// Display Messages (accumulated for rendering)
// ---------------------------------------------------------------------------

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: DisplayBlock[];
  timestamp: number;
  /** Cost for this turn */
  costUsd?: number;
  /** Duration for this turn */
  durationMs?: number;
}

export type DisplayBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; collapsed?: boolean }
  | { type: 'tool_use'; toolId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; toolId: string; content: string; isError?: boolean }
  | { type: 'error'; message: string };
