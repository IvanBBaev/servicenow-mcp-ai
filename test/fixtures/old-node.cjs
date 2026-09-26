// Test fixture for test/cli-spawn.test.js: preloaded with --require to make
// the bin launcher believe it runs on an old Node, so its version guard fires.
"use strict";
Object.defineProperty(process, "versions", {
  value: Object.assign({}, process.versions, { node: "18.0.0" }),
});
