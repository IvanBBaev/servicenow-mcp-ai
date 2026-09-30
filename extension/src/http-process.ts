/**
 * `servicenowMcp.transport: "http"` — the extension owns the server process:
 * it spawns `servicenow-mcp-ai` with `SN_TRANSPORT=http` on a free loopback
 * port with a random per-launch bearer token, waits until the port accepts
 * connections, and hands VS Code the URL and the `Authorization` header. The
 * server's Streamable HTTP transport serves one session, so every start of the
 * server definition launches a fresh process and stops the previous one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { serverLaunch } from "./doctor";

export interface HttpServerHandle {
  url: string;
  headers: Record<string, string>;
}

const HOST = "127.0.0.1";
/** `npx -y` may download the package on first use. */
const READY_TIMEOUT_MS = 120_000;

/** Ask the OS for a free loopback port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class HttpServerProcess {
  private child: ChildProcess | undefined;

  constructor(private readonly log: (line: string) => void) {}

  /** Stop any running process, then launch a new one and wait until it listens. */
  async start(env: Record<string, string>): Promise<HttpServerHandle> {
    this.stop();
    const port = await freePort();
    const token = randomBytes(24).toString("base64url");
    const launch = serverLaunch();
    const child = spawn(launch.command, launch.args, {
      shell: launch.shell,
      env: {
        ...process.env,
        ...env,
        SN_TRANSPORT: "http",
        SN_HTTP_HOST: HOST,
        SN_PORT: String(port),
        SN_HTTP_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.log(chunk.trimEnd()));

    let exited: string | undefined;
    child.once("exit", (code, signal) => {
      exited = `exited (${signal ?? `code ${code}`})`;
      this.log(`[http server] ${exited}`);
      if (this.child === child) this.child = undefined;
    });
    child.once("error", (error) => {
      exited = error.message;
      this.log(`[http server] failed to start: ${error.message}`);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`ServiceNow MCP http server ${exited}`);
      if (await canConnect(port)) {
        return {
          url: `http://${HOST}:${port}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.stop();
    throw new Error(
      `ServiceNow MCP http server did not listen within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill();
  }
}
