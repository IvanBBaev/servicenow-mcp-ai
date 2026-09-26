// E-9 crash-handler probe, run as a child process by test/lifecycle.test.js.
//
//   node crash-probe.mjs rejection   → an unhandled promise rejection
//   node crash-probe.mjs exception   → an uncaught exception thrown from a timer
//
// A keep-alive interval guarantees that only the handler's exit() can end the
// process — a drained event loop would exit on its own and prove nothing. The
// 'exit' hook reports the handler's own latency on stdout (synchronously, so
// it survives process.exit); stderr stays reserved for the single crash line.
import { writeSync } from "node:fs";
import { installCrashHandlers } from "../../build/core/lifecycle.js";

installCrashHandlers();
setInterval(() => {}, 60_000);

let crashAt = 0;
process.on("exit", (code) => {
  writeSync(
    1,
    JSON.stringify({ code, msSinceCrash: performance.now() - crashAt }),
  );
});

const mode = process.argv[2];
if (mode === "rejection") {
  crashAt = performance.now();
  Promise.reject(new Error("boom: injected rejection"));
} else if (mode === "exception") {
  setTimeout(() => {
    crashAt = performance.now();
    throw new Error("boom: injected exception");
  }, 0);
} else {
  process.stderr.write(`crash-probe: unknown mode "${mode}"\n`);
  process.exit(2);
}
