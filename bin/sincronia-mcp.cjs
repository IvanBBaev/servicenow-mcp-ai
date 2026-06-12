#!/usr/bin/env node
// CommonJS launcher whose only job is the Node version guard. It must stay
// parseable by ancient Node (no ?., ??, ESM syntax): the real entry is an ESM
// graph that old Node fails to *parse*, so a guard inside it can never run.
"use strict";

var major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  console.error(
    "sincronia-mcp requires Node.js >= 20, but this is " +
      process.versions.node +
      ".\nUse a newer runtime, e.g.: nvm install 22 && nvm use 22",
  );
  process.exit(1);
}

import("../build/index.js").catch(function (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
