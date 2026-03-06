/**
 * SSE Stream API Route for Next.js integration.
 *
 * Copy this file to:
 *   packages/frontend/src/app/api/claude-agent/stream/route.ts
 *
 * Works with the session store from ../claude-agent/route.ts
 * (they share the same Node.js process in Next.js).
 */

import { NextRequest, NextResponse } from 'next/server';

// Re-export the POST_stream handler as POST
// In practice, copy the POST_stream function from next-api-route.ts
// and rename it to POST in this file.

/**
 * This is a template. In your actual implementation:
 *
 * 1. Create a shared module for the session store:
 *    packages/frontend/src/lib/claude-agent-store.ts
 *
 * 2. Import sessions from that shared module in both route files.
 *
 * Example shared store:
 *
 * ```typescript
 * // lib/claude-agent-store.ts
 * export interface AgentSession {
 *   id: string;
 *   sdkSessionId?: string;
 *   name: string;
 *   cwd: string;
 *   model: string;
 *   permissionMode: string;
 *   status: 'idle' | 'busy' | 'closed';
 *   createdAt: number;
 *   lastActiveAt: number;
 *   queryCount: number;
 *   totalCostUsd: number;
 * }
 *
 * // Singleton store (persists within Next.js server process)
 * export const agentSessions = new Map<string, AgentSession>();
 * let counter = 0;
 *
 * export function createAgentSession(opts: Partial<AgentSession> = {}): AgentSession {
 *   const id = `s-${++counter}-${Date.now().toString(36)}`;
 *   const session: AgentSession = {
 *     id,
 *     name: opts.name ?? `Session ${counter}`,
 *     cwd: opts.cwd ?? process.env.DEFAULT_CWD ?? process.cwd(),
 *     model: opts.model ?? 'claude-sonnet-4-5-20250929',
 *     permissionMode: opts.permissionMode ?? 'acceptEdits',
 *     status: 'idle',
 *     createdAt: Date.now(),
 *     lastActiveAt: Date.now(),
 *     queryCount: 0,
 *     totalCostUsd: 0,
 *   };
 *   agentSessions.set(id, session);
 *   return session;
 * }
 * ```
 *
 * Then in both route files:
 * ```typescript
 * import { agentSessions, createAgentSession } from '@/lib/claude-agent-store';
 * ```
 */

export async function POST(req: NextRequest) {
  const { sessionId, prompt } = await req.json();

  if (!sessionId || !prompt) {
    return NextResponse.json({ error: 'sessionId and prompt required' }, { status: 400 });
  }

  // Import shared store (adjust path for your project)
  // const { agentSessions } = await import('@/lib/claude-agent-store');

  // This is a template — see the full implementation in next-api-route.ts POST_stream
  return NextResponse.json(
    { error: 'Copy POST_stream from next-api-route.ts and wire up shared session store' },
    { status: 501 },
  );
}
