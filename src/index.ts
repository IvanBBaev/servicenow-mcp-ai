#!/usr/bin/env node
// Node guard for the case when build/index.js is started directly (the bin
// launcher already checks before parsing the ESM graph). Runs before the
// module graph of the CLI is evaluated — every other import is dynamic —
// and uses no syntax newer than what Node 14 parses.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
  .split(".")
  .map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error(
    `servicenow-mcp-ai requires Node.js >= 22.12, but this is ${process.versions.node}. Use e.g. nvm use 22.`,
  );
  process.exit(1);
}

// D-1: the entry point only dispatches; `cli.ts` parses the arguments and runs
// a subcommand (init, doctor, login, drift, support-bundle) or, with no
// command, starts the MCP server (`server.ts`). No module starts the server
// at import time.
const { main } = await import("./cli.js");
await main(process.argv.slice(2));
