/**
 * React hook for interacting with Claude Agent Bridge.
 *
 * Manages session lifecycle, SSE streaming, and message accumulation.
 *
 * Usage:
 *   const { messages, send, isStreaming, session, createSession } = useClaudeAgent({
 *     bridgeUrl: 'http://localhost:3200',
 *   });
 */

import { useState, useCallback, useRef } from 'react';
import type {
  Session,
  SSEEvent,
  DisplayMessage,
  DisplayBlock,
  TextEventData,
  ThinkingEventData,
  ToolUseEventData,
  ToolResultEventData,
  ResultEventData,
  ErrorEventData,
  PermissionMode,
} from '../types.js';

export interface UseClaudeAgentOptions {
  /** Base URL of the bridge server */
  bridgeUrl: string;
  /** Auto-create a session on mount */
  autoCreateSession?: boolean;
  /** Default session options */
  defaultSessionOptions?: {
    name?: string;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionMode;
  };
}

export interface UseClaudeAgentReturn {
  /** All display messages */
  messages: DisplayMessage[];
  /** Current session info */
  session: Session | null;
  /** Whether a query is in progress */
  isStreaming: boolean;
  /** Send a prompt */
  send: (prompt: string) => Promise<void>;
  /** Create a new session */
  createSession: (options?: {
    name?: string;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionMode;
  }) => Promise<Session>;
  /** Close the current session */
  closeSession: () => Promise<void>;
  /** Clear messages (UI only) */
  clearMessages: () => void;
  /** Error message if any */
  error: string | null;
}

let msgCounter = 0;
function nextId() {
  return `msg-${++msgCounter}-${Date.now()}`;
}

export function useClaudeAgent(options: UseClaudeAgentOptions): UseClaudeAgentReturn {
  const { bridgeUrl } = options;

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  const createSession = useCallback(
    async (opts: { name?: string; cwd?: string; model?: string; permissionMode?: PermissionMode } = {}) => {
      const merged = { ...options.defaultSessionOptions, ...opts };
      const res = await fetch(`${bridgeUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.statusText}`);
      const newSession: Session = await res.json();
      setSession(newSession);
      setError(null);
      return newSession;
    },
    [bridgeUrl, options.defaultSessionOptions],
  );

  const closeSession = useCallback(async () => {
    if (!session) return;
    abortRef.current?.abort();
    await fetch(`${bridgeUrl}/api/session/${session.id}`, { method: 'DELETE' });
    setSession(null);
  }, [bridgeUrl, session]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // -----------------------------------------------------------------------
  // Streaming query
  // -----------------------------------------------------------------------

  const send = useCallback(
    async (prompt: string) => {
      let activeSession = session;

      // Auto-create session if needed
      if (!activeSession) {
        activeSession = await createSession(options.defaultSessionOptions);
      }

      setError(null);
      setIsStreaming(true);

      // Add user message
      const userMsg: DisplayMessage = {
        id: nextId(),
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Prepare assistant message accumulator
      const assistantMsg: DisplayMessage = {
        id: nextId(),
        role: 'assistant',
        blocks: [],
        timestamp: Date.now(),
      };

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const res = await fetch(`${bridgeUrl}/api/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeSession.id, prompt }),
          signal: abortController.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Stream request failed: ${res.statusText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;

            try {
              const event: SSEEvent = JSON.parse(payload);
              const block = eventToBlock(event);
              if (block) {
                assistantMsg.blocks.push(block);
                // Update result metadata
                if (event.type === 'result') {
                  const data = event.data as ResultEventData;
                  assistantMsg.costUsd = data.costUsd;
                  assistantMsg.durationMs = data.durationMs;
                }
                // Trigger re-render with new blocks
                setMessages((prev) => {
                  const existing = prev.find((m) => m.id === assistantMsg.id);
                  if (existing) {
                    return prev.map((m) =>
                      m.id === assistantMsg.id ? { ...assistantMsg, blocks: [...assistantMsg.blocks] } : m,
                    );
                  }
                  return [...prev, { ...assistantMsg, blocks: [...assistantMsg.blocks] }];
                });
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Refresh session state
        const sessionRes = await fetch(`${bridgeUrl}/api/session/${activeSession.id}`);
        if (sessionRes.ok) {
          setSession(await sessionRes.json());
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const errMsg = err instanceof Error ? err.message : String(err);
          setError(errMsg);
          assistantMsg.blocks.push({ type: 'error', message: errMsg });
          setMessages((prev) => {
            const existing = prev.find((m) => m.id === assistantMsg.id);
            if (existing) {
              return prev.map((m) =>
                m.id === assistantMsg.id ? { ...assistantMsg } : m,
              );
            }
            return [...prev, assistantMsg];
          });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [bridgeUrl, session, createSession, options.defaultSessionOptions],
  );

  return { messages, session, isStreaming, send, createSession, closeSession, clearMessages, error };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventToBlock(event: SSEEvent): DisplayBlock | null {
  switch (event.type) {
    case 'text': {
      const data = event.data as TextEventData;
      return { type: 'text', text: data.text };
    }
    case 'thinking': {
      const data = event.data as ThinkingEventData;
      return { type: 'thinking', thinking: data.thinking };
    }
    case 'tool_use': {
      const data = event.data as ToolUseEventData;
      return {
        type: 'tool_use',
        toolId: data.toolId,
        toolName: data.toolName,
        toolInput: data.toolInput,
      };
    }
    case 'tool_result': {
      const data = event.data as ToolResultEventData;
      return {
        type: 'tool_result',
        toolId: data.toolId,
        content: data.content,
        isError: data.isError,
      };
    }
    case 'error': {
      const data = event.data as ErrorEventData;
      return { type: 'error', message: data.message };
    }
    case 'result': {
      const data = event.data as ResultEventData;
      if (data.result) {
        return { type: 'text', text: data.result };
      }
      return null;
    }
    default:
      return null;
  }
}
