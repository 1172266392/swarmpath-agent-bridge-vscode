/**
 * Drop-in Next.js API Route for Claude Agent Bridge.
 *
 * Copy this file to your Next.js project:
 *   packages/frontend/src/app/api/claude-agent/route.ts
 *
 * This embeds the bridge directly in your Next.js backend,
 * eliminating the need for the standalone bridge server.
 *
 * Requirements:
 *   npm install @anthropic-ai/claude-agent-sdk nanoid
 *
 * Frontend usage:
 *   POST /api/claude-agent          → Create/list sessions
 *   POST /api/claude-agent/stream   → SSE stream
 */

import { NextRequest, NextResponse } from 'next/server';

// ---- Inline session store (singleton in Next.js server) ----

interface Session {
  id: string;
  sdkSessionId?: string;
  name: string;
  cwd: string;
  model: string;
  permissionMode: string;
  status: 'idle' | 'busy' | 'closed';
  createdAt: number;
  lastActiveAt: number;
  queryCount: number;
  totalCostUsd: number;
}

const sessions = new Map<string, Session>();
let counter = 0;

function createSession(body: Record<string, string> = {}): Session {
  const id = `s-${++counter}-${Date.now().toString(36)}`;
  const session: Session = {
    id,
    name: body.name ?? `Session ${counter}`,
    cwd: body.cwd ?? process.env.DEFAULT_CWD ?? process.cwd(),
    model: body.model ?? process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-5-20250929',
    permissionMode: body.permissionMode ?? 'acceptEdits',
    status: 'idle',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    queryCount: 0,
    totalCostUsd: 0,
  };
  sessions.set(id, session);
  return session;
}

// ---- REST handler ----

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const session = createSession(body);
  return NextResponse.json(session, { status: 201 });
}

export async function GET() {
  const list = Array.from(sessions.values())
    .filter((s) => s.status !== 'closed')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return NextResponse.json(list);
}

// ---- SSE streaming handler (separate route file: stream/route.ts) ----

/**
 * Create a file at: api/claude-agent/stream/route.ts
 * with the following content:
 */
export async function POST_stream(req: NextRequest) {
  const { sessionId, prompt } = await req.json();

  const session = sessions.get(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  session.status = 'busy';
  session.lastActiveAt = Date.now();

  // Dynamic import
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const queryOpts: Record<string, unknown> = {
          permissionMode: session.permissionMode,
          cwd: session.cwd,
          maxTurns: 30,
          includePartialMessages: true,
          model: session.model,
          env: { ...process.env },
        };

        if (session.sdkSessionId) {
          queryOpts.resume = session.sdkSessionId;
        }

        const q = query({ prompt, options: queryOpts });

        for await (const rawMsg of q) {
          const raw = rawMsg as Record<string, unknown>;

          // Capture SDK session ID
          if (raw.session_id && !session.sdkSessionId) {
            session.sdkSessionId = raw.session_id as string;
          }

          // Transform to SSE
          const events = transformMessage(raw);
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }

          // Capture cost
          if (raw.type === 'result') {
            session.totalCostUsd += (raw.total_cost_usd as number) ?? 0;
            session.queryCount++;
          }
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        const errEvent = {
          type: 'error',
          data: { message: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        session.status = 'idle';
        session.lastActiveAt = Date.now();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ---- Message transform (inline for single-file deployment) ----

interface SSEEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

function transformMessage(raw: Record<string, unknown>): SSEEvent[] {
  const events: SSEEvent[] = [];
  const now = Date.now();

  if (raw.type === 'assistant') {
    const message = raw.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        const btype = block.type as string;
        if (btype === 'text') {
          events.push({ type: 'text', data: { text: block.text }, timestamp: now });
        } else if (btype === 'thinking') {
          events.push({ type: 'thinking', data: { thinking: block.thinking }, timestamp: now });
        } else if (btype === 'tool_use') {
          events.push({
            type: 'tool_use',
            data: { toolId: block.id, toolName: block.name, toolInput: block.input },
            timestamp: now,
          });
        } else if (btype === 'tool_result') {
          const resultContent = extractText(block.content);
          events.push({
            type: 'tool_result',
            data: { toolId: block.tool_use_id, content: resultContent },
            timestamp: now,
          });
        }
      }
    }
  } else if (raw.type === 'result') {
    events.push({
      type: 'result',
      data: {
        subtype: raw.subtype,
        result: raw.result,
        costUsd: raw.total_cost_usd,
        durationMs: raw.duration_ms,
        numTurns: raw.num_turns,
        sessionId: raw.session_id,
        isError: raw.is_error,
      },
      timestamp: now,
    });
  } else if (raw.type === 'system') {
    events.push({ type: 'session_init', data: { sessionId: raw.session_id }, timestamp: now });
  }

  return events;
}

function extractText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item !== null
            ? ((item as Record<string, unknown>).text as string) ?? ''
            : String(item),
      )
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}
