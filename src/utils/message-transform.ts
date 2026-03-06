/**
 * Transform raw SDK messages into SSE events for the frontend.
 * Handles ALL 21+ SDK message types.
 */

import type {
  RawSDKMessage,
  RawContentBlock,
  SSEEvent,
  TextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  ResultEvent,
  AgentStatusEvent,
  StreamDeltaEvent,
  ToolProgressEvent,
  ToolSummaryEvent,
  TaskStartedEvent,
  TaskProgressEvent,
  TaskNotificationEvent,
  StatusEvent,
  RateLimitEvent,
  PromptSuggestionEvent,
  HookStatusEvent,
  CompactBoundaryEvent,
  LocalCommandEvent,
  AuthStatusEvent,
  P2PMessageEvent,
} from '../types.js';

/**
 * Transform a raw SDK message into one or more SSE events.
 */
export function transformSDKMessage(raw: RawSDKMessage): SSEEvent[] {
  const events: SSEEvent[] = [];
  const now = Date.now();

  switch (raw.type) {
    // ---- Assistant message with content blocks ----
    case 'assistant': {
      if (raw.message?.content) {
        for (const block of raw.message.content) {
          const event = transformContentBlock(block, now);
          if (event) events.push(event);
        }
        // Detect Agent Teams tool usage
        extractAgentTeamsEvents(raw.message.content, events, now);
      }
      break;
    }

    // ---- Streaming partial messages (real-time deltas) ----
    case 'stream_event': {
      const evt = raw.event;
      if (!evt) break;

      if (evt.type === 'content_block_delta' && evt.delta) {
        const delta = evt.delta;
        if (delta.type === 'text_delta' && delta.text) {
          events.push({
            type: 'stream_delta',
            data: { delta: delta.text, blockType: 'text', blockIndex: evt.index } satisfies StreamDeltaEvent,
            timestamp: now,
          });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          events.push({
            type: 'stream_delta',
            data: { delta: delta.thinking, blockType: 'thinking', blockIndex: evt.index } satisfies StreamDeltaEvent,
            timestamp: now,
          });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          events.push({
            type: 'stream_delta',
            data: { delta: delta.partial_json, blockType: 'tool_input', blockIndex: evt.index } satisfies StreamDeltaEvent,
            timestamp: now,
          });
        }
      } else if (evt.type === 'content_block_start' && evt.content_block) {
        const cb = evt.content_block;
        if (cb.type === 'tool_use') {
          events.push({
            type: 'stream_delta',
            data: { delta: '', blockType: 'tool_start', blockIndex: evt.index, toolName: cb.name, toolId: cb.id } as Record<string, unknown>,
            timestamp: now,
          });
        }
      }
      break;
    }

    // ---- Final result ----
    case 'result': {
      const data: ResultEvent = {
        subtype: raw.subtype ?? 'unknown',
        result: raw.result,
        costUsd: raw.total_cost_usd,
        durationMs: raw.duration_ms,
        durationApiMs: raw.duration_api_ms,
        numTurns: raw.num_turns,
        sessionId: raw.session_id,
        isError: raw.is_error,
        errors: raw.errors,
        usage: raw.usage as ResultEvent['usage'],
        modelUsage: raw.modelUsage as Record<string, unknown>,
      };
      events.push({ type: 'result', data, timestamp: now });
      break;
    }

    // ---- System messages (multiple subtypes) ----
    case 'system': {
      switch (raw.subtype) {
        case 'init': {
          events.push({
            type: 'session_init',
            data: {
              sessionId: raw.session_id,
              availableAgents: raw.agents,
              tools: raw.tools,
              model: raw.model,
              cwd: raw.cwd,
              version: raw.claude_code_version,
              permissionMode: raw.permissionMode,
              mcpServers: raw.mcp_servers,
              slashCommands: raw.slash_commands,
              skills: raw.skills,
            },
            timestamp: now,
          });
          break;
        }
        case 'status': {
          events.push({
            type: 'status',
            data: {
              status: (raw.status as string) ?? null,
              permissionMode: raw.permissionMode as StatusEvent['permissionMode'],
            } satisfies StatusEvent,
            timestamp: now,
          });
          break;
        }
        case 'compact_boundary': {
          events.push({
            type: 'compact_boundary',
            data: {
              trigger: (raw.compact_metadata?.trigger as CompactBoundaryEvent['trigger']) ?? 'auto',
              preTokens: raw.compact_metadata?.pre_tokens ?? 0,
            } satisfies CompactBoundaryEvent,
            timestamp: now,
          });
          break;
        }
        case 'task_started': {
          events.push({
            type: 'task_started',
            data: {
              taskId: raw.task_id ?? '',
              description: raw.description ?? '',
              taskType: raw.task_type,
            } satisfies TaskStartedEvent,
            timestamp: now,
          });
          break;
        }
        case 'task_progress': {
          const tpUsage = raw.usage ? {
            totalTokens: (raw.usage as Record<string, number>).total_tokens ?? 0,
            toolUses: (raw.usage as Record<string, number>).tool_uses ?? 0,
            durationMs: (raw.usage as Record<string, number>).duration_ms ?? 0,
          } : undefined;
          events.push({
            type: 'task_progress',
            data: {
              taskId: raw.task_id ?? '',
              description: raw.description ?? '',
              usage: tpUsage,
              lastToolName: raw.last_tool_name as string | undefined,
            } satisfies TaskProgressEvent,
            timestamp: now,
          });
          break;
        }
        case 'task_notification': {
          const tnUsage = raw.usage ? {
            totalTokens: (raw.usage as Record<string, number>).total_tokens ?? 0,
            toolUses: (raw.usage as Record<string, number>).tool_uses ?? 0,
            durationMs: (raw.usage as Record<string, number>).duration_ms ?? 0,
          } : undefined;
          events.push({
            type: 'task_notification',
            data: {
              taskId: raw.task_id ?? '',
              status: (raw.status ?? 'completed') as TaskNotificationEvent['status'],
              summary: raw.summary ?? '',
              usage: tnUsage,
            } satisfies TaskNotificationEvent,
            timestamp: now,
          });
          break;
        }
        case 'hook_started': {
          events.push({
            type: 'hook_status',
            data: {
              hookId: raw.hook_id ?? '',
              hookName: raw.hook_name ?? '',
              hookEvent: raw.hook_event ?? '',
              phase: 'started',
            } satisfies HookStatusEvent,
            timestamp: now,
          });
          break;
        }
        case 'hook_progress': {
          events.push({
            type: 'hook_status',
            data: {
              hookId: raw.hook_id ?? '',
              hookName: raw.hook_name ?? '',
              hookEvent: raw.hook_event ?? '',
              phase: 'progress',
              output: raw.output ?? raw.stdout ?? '',
            } satisfies HookStatusEvent,
            timestamp: now,
          });
          break;
        }
        case 'hook_response': {
          events.push({
            type: 'hook_status',
            data: {
              hookId: raw.hook_id ?? '',
              hookName: raw.hook_name ?? '',
              hookEvent: raw.hook_event ?? '',
              phase: 'response',
              output: raw.output ?? '',
              exitCode: raw.exit_code,
              outcome: raw.outcome as HookStatusEvent['outcome'],
            } satisfies HookStatusEvent,
            timestamp: now,
          });
          break;
        }
        case 'local_command_output': {
          events.push({
            type: 'local_command',
            data: { content: raw.content ?? '' } satisfies LocalCommandEvent,
            timestamp: now,
          });
          break;
        }
        case 'elicitation_complete': {
          // Forward as status info
          events.push({
            type: 'status',
            data: { status: null, permissionMode: undefined } satisfies StatusEvent,
            timestamp: now,
          });
          break;
        }
        case 'files_persisted': {
          // Forward as status notification
          events.push({
            type: 'status',
            data: { status: 'files_persisted' } as Record<string, unknown>,
            timestamp: now,
          });
          break;
        }
        default:
          break;
      }
      break;
    }

    // ---- Tool progress (elapsed time during execution) ----
    case 'tool_progress': {
      events.push({
        type: 'tool_progress',
        data: {
          toolUseId: raw.tool_use_id ?? '',
          toolName: raw.tool_name ?? '',
          elapsedSeconds: raw.elapsed_time_seconds ?? 0,
          taskId: raw.task_id,
        } satisfies ToolProgressEvent,
        timestamp: now,
      });
      break;
    }

    // ---- Tool use summary ----
    case 'tool_use_summary': {
      events.push({
        type: 'tool_summary',
        data: {
          summary: raw.summary ?? '',
          toolUseIds: raw.preceding_tool_use_ids ?? [],
        } satisfies ToolSummaryEvent,
        timestamp: now,
      });
      break;
    }

    // ---- Rate limit event ----
    case 'rate_limit_event': {
      const info = raw.rate_limit_info ?? {};
      events.push({
        type: 'rate_limit',
        data: {
          status: (info as Record<string, unknown>).status as string ?? 'unknown',
          resetsAt: (info as Record<string, unknown>).resetsAt as number | undefined,
          rateLimitType: (info as Record<string, unknown>).rateLimitType as string | undefined,
          utilization: (info as Record<string, unknown>).utilization as number | undefined,
        } satisfies RateLimitEvent,
        timestamp: now,
      });
      break;
    }

    // ---- Auth status ----
    case 'auth_status': {
      events.push({
        type: 'auth_status',
        data: {
          isAuthenticating: raw.isAuthenticating ?? false,
          output: (Array.isArray(raw.output) ? raw.output : []) as string[],
          error: raw.error,
        } satisfies AuthStatusEvent,
        timestamp: now,
      });
      break;
    }

    // ---- Prompt suggestion ----
    case 'prompt_suggestion': {
      events.push({
        type: 'prompt_suggestion',
        data: { suggestion: raw.suggestion ?? '' } satisfies PromptSuggestionEvent,
        timestamp: now,
      });
      break;
    }

    // ---- User message — extract tool_result blocks (MCP tool results with images) ----
    case 'user': {
      const userContent = raw.message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'tool_result') {
            const event = transformContentBlock(block as RawContentBlock, now);
            if (event) events.push(event);
          }
        }
      }
      break;
    }

    default:
      break;
  }

  return events;
}

function transformContentBlock(block: RawContentBlock, timestamp: number): SSEEvent | null {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        data: { text: block.text ?? '' } satisfies TextEvent,
        timestamp,
      };

    case 'thinking':
      return {
        type: 'thinking',
        data: { thinking: block.thinking ?? '' } satisfies ThinkingEvent,
        timestamp,
      };

    case 'tool_use':
      return {
        type: 'tool_use',
        data: {
          toolId: block.id ?? '',
          toolName: block.name ?? '',
          toolInput: block.input ?? {},
        } satisfies ToolUseEvent,
        timestamp,
      };

    case 'tool_result': {
      const extracted = extractToolResult(block.content);
      return {
        type: 'tool_result',
        data: {
          toolId: block.tool_use_id ?? '',
          content: extracted.text,
          ...(extracted.images.length > 0 ? { images: extracted.images } : {}),
        } satisfies ToolResultEvent,
        timestamp,
      };
    }

    default:
      return null;
  }
}

/**
 * Detect Agent Teams related tool usage and emit agent_status events.
 */
function extractAgentTeamsEvents(
  blocks: RawContentBlock[],
  events: SSEEvent[],
  timestamp: number,
): void {
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    const input = block.input as Record<string, unknown> | undefined;

    if (block.name === 'Agent') {
      events.push({
        type: 'agent_status',
        data: {
          action: 'subagent_start',
          agentId: block.id,
          agentType: (input?.subagent_type as string) || 'general-purpose',
          description: (input?.description as string) || undefined,
          teammateName: (input?.name as string) || undefined,
          teamName: (input?.team_name as string) || undefined,
          isBackground: !!(input?.run_in_background),
        } satisfies AgentStatusEvent,
        timestamp,
      });
    } else if (block.name === 'TeamCreate') {
      events.push({
        type: 'agent_status',
        data: {
          action: 'subagent_start',
          agentId: block.id,
          agentType: 'team',
          description: (input?.description as string) || undefined,
          teamName: (input?.team_name as string) || undefined,
        } satisfies AgentStatusEvent,
        timestamp,
      });
    } else if (block.name === 'TeamDelete') {
      events.push({
        type: 'agent_status',
        data: {
          action: 'subagent_stop',
          agentId: block.id,
          agentType: 'team',
          teamName: undefined, // team context cleared by SDK
        } satisfies AgentStatusEvent,
        timestamp,
      });
    } else if (block.name === 'ExitPlanMode') {
      events.push({
        type: 'plan_submitted',
        data: {
          allowedPrompts: (input?.allowedPrompts as unknown[]) || [],
        },
        timestamp,
      });
    } else if (block.name === 'SendMessage') {
      const msgType = input?.type as string | undefined;
      const recipient = (input?.recipient as string) || undefined;
      const contentStr = (input?.content as string) || '';

      // Detect plan_approval JSON inside SendMessage content
      try {
        const parsed = JSON.parse(contentStr);
        if (parsed.type === 'plan_approval_request') {
          events.push({
            type: 'plan_approval_request',
            data: {
              requestId: parsed.requestId ?? '',
              from: parsed.from ?? recipient ?? '',
              planContent: parsed.planContent ?? parsed.plan ?? '',
              planFilePath: parsed.planFilePath,
            },
            timestamp,
          });
        } else if (parsed.type === 'plan_approval_response') {
          events.push({
            type: 'plan_approval_response',
            data: {
              requestId: parsed.requestId ?? '',
              approved: !!parsed.approved,
              feedback: parsed.feedback,
            },
            timestamp,
          });
        }
      } catch { /* non-JSON content — normal SendMessage */ }

      if (msgType === 'shutdown_request') {
        events.push({
          type: 'agent_status',
          data: {
            action: 'subagent_stop',
            teammateName: recipient,
            lastMessage: '关闭请求已发送',
          } satisfies AgentStatusEvent,
          timestamp,
        });
      } else {
        events.push({
          type: 'agent_status',
          data: {
            action: 'teammate_idle',
            teammateName: recipient,
            lastMessage: contentStr.slice(0, 200) || undefined,
          } satisfies AgentStatusEvent,
          timestamp,
        });
      }

      // Emit P2P message event for real message/broadcast communications
      if (msgType === 'message' || msgType === 'broadcast') {
        events.push({
          type: 'p2p_message',
          data: {
            fromAgent: 'team-lead',
            toAgent: recipient || 'all',
            messageType: msgType as P2PMessageEvent['messageType'],
            contentPreview: contentStr.slice(0, 200),
          } satisfies P2PMessageEvent,
          timestamp,
        });
      }
    } else if (block.name === 'TaskUpdate' && input?.status === 'completed') {
      events.push({
        type: 'agent_status',
        data: {
          action: 'task_completed',
          taskId: (input?.taskId as string) || undefined,
          taskSubject: (input?.subject as string) || undefined,
        } satisfies AgentStatusEvent,
        timestamp,
      });
    }
  }
}

interface ToolResultExtracted {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

function extractToolResult(content: unknown): ToolResultExtracted {
  const result: ToolResultExtracted = { text: '', images: [] };
  if (!content) return result;
  if (typeof content === 'string') { result.text = content; return result; }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') { texts.push(item); continue; }
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        // Text content block
        if (obj.type === 'text' && typeof obj.text === 'string') {
          texts.push(obj.text);
        }
        // Image content block (MCP format: { type: "image", data: "base64...", mimeType: "image/png" })
        else if (obj.type === 'image' && typeof obj.data === 'string') {
          result.images.push({ data: obj.data as string, mimeType: (obj.mimeType as string) || 'image/png' });
        }
        // Image with source wrapper: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
        else if (obj.type === 'image' && typeof obj.source === 'object' && obj.source !== null) {
          const src = obj.source as Record<string, unknown>;
          if (typeof src.data === 'string') {
            result.images.push({ data: src.data as string, mimeType: (src.media_type as string) || 'image/png' });
          }
        }
        // Fallback: extract text field
        else if (typeof obj.text === 'string') {
          texts.push(obj.text);
        }
      }
    }
    result.text = texts.filter(Boolean).join('\n');
    return result;
  }
  result.text = String(content);
  return result;
}

export function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function formatSSEDone(): string {
  return `data: [DONE]\n\n`;
}
