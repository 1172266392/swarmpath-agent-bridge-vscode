/**
 * Claude Agent Bridge — Entry Point
 *
 * Bridges Claude Agent SDK → SSE → Web Frontend
 * Provides full Claude Code terminal capabilities through HTTP.
 */

import 'dotenv/config';
import { createServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3300', 10);
const HOST = '0.0.0.0';

async function main() {
  const app = await createServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n  Claude Agent Bridge running at http://localhost:${PORT}`);
    console.log(`  Health check:  http://localhost:${PORT}/health`);
    console.log(`  API docs:      POST /api/session, POST /api/stream`);
    console.log(`  Default CWD:   ${process.env.DEFAULT_CWD ?? process.cwd()}`);
    console.log(`  Default model: ${process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-5-20250929'}\n`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
