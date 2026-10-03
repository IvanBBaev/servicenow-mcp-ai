// Test fixture for test/cli-spawn.test.js: preloaded with --require to make
// the bin launcher believe it runs on an old Node, so its version guard fires.
// FAKE_NODE_VERSION picks the version (default 18.0.0).
"use strict";
Object.defineProperty(process, "versions", {
  value: Object.assign({}, process.versions, {
    node: process.env.FAKE_NODE_VERSION || "18.0.0",
  }),
});
