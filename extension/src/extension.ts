import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as vscode from "vscode";
import {
  buildServerEnv,
  definitionVersion,
  describeCredentials,
  normalizeSettings,
  parseStoredCredentials,
  SECRET_KEY,
  SETTINGS_SECTION,
  validateInstance,
  type ExtensionSettings,
  type PathContext,
  type SignInMethod,
  type StoredCredentials,
} from "./config";
import { serverLaunch, summarizeDoctor, type DoctorSummary } from "./doctor";
import { HttpServerProcess } from "./http-process";
import {
  copySkills,
  planSkillCopy,
  SKILL_TARGETS,
  skillsSource,
} from "./skills";

const PROVIDER_ID = "servicenow-mcp-ai";
const SERVER_LABEL = "ServiceNow";
const REVISION_KEY = "servicenowMcp.signInRevision";
const DOCTOR_TIMEOUT_MS = 180_000;

/**
 * Registers the `servicenow-mcp-ai` MCP server with VS Code so it appears in
 * Copilot Chat (agent mode) the moment the extension is installed — no manual
 * `.vscode/mcp.json`. The server runs via `npx -y servicenow-mcp-ai@3.x`
 * (`SERVER_SPEC` in `config.ts`, the pinned major — D-6).
 *
 * Credentials come from, in order of precedence: the SecretStorage sign-in
 * (`ServiceNow MCP: Sign In`), passed to the process as environment variables
 * only when the server starts; the env file (`servicenowMcp.envFile`, else the
 * server's own default `~/.config/servicenow-mcp-ai/.env`); or, at runtime,
 * the `servicenow_set_credentials` tool.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ServiceNow MCP");
  const didChange = new vscode.EventEmitter<void>();
  const http = new HttpServerProcess((line) => output.appendLine(line));
  const status = vscode.window.createStatusBarItem(
    "servicenowMcp.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.name = "ServiceNow MCP";
  status.command = "servicenowMcp.runDoctor";

  const readSettings = (): ExtensionSettings =>
    normalizeSettings({
      envFile: vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .get<unknown>("envFile"),
      packages: vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .get<unknown>("packages"),
      transport: vscode.workspace
        .getConfiguration(SETTINGS_SECTION)
        .get<unknown>("transport"),
    });

  const pathContext = (): PathContext => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      home: homedir(),
      ...(folder?.uri.scheme === "file"
        ? { workspaceFolder: folder.uri.fsPath }
        : {}),
    };
  };

  const readCredentials = async (): Promise<StoredCredentials | undefined> =>
    parseStoredCredentials(await context.secrets.get(SECRET_KEY));

  const revision = (): number =>
    context.globalState.get<number>(REVISION_KEY, 0);

  /** The full environment for a server or doctor process (secrets included). */
  const serverEnv = async (): Promise<Record<string, string>> =>
    buildServerEnv(readSettings(), pathContext(), await readCredentials());

  // ---------------------------------------------------------------------------
  // Status bar
  // ---------------------------------------------------------------------------

  let lastDoctor: DoctorSummary | undefined;

  const refreshStatus = async (): Promise<void> => {
    const creds = await readCredentials();
    const settings = readSettings();
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**ServiceNow MCP**\n\n");
    if (creds) {
      tooltip.appendText(`Signed in: ${describeCredentials(creds)}\n\n`);
    } else if (settings.envFile) {
      tooltip.appendText(`Env file: ${settings.envFile}\n\n`);
    } else {
      tooltip.appendText(
        "Not signed in — using the server's default env file, if any.\n\n",
      );
    }
    if (lastDoctor) tooltip.appendText(`${lastDoctor.headline}\n\n`);
    tooltip.appendMarkdown("Click to run `doctor`.");

    const icon = lastDoctor
      ? {
          healthy: "$(pass)",
          degraded: "$(warning)",
          not_configured: "$(circle-slash)",
          error: "$(error)",
        }[lastDoctor.status]
      : creds || settings.envFile
        ? "$(plug)"
        : "$(circle-slash)";
    status.text = `${icon} ServiceNow`;
    status.tooltip = tooltip;
    status.backgroundColor =
      lastDoctor?.status === "error" || lastDoctor?.status === "not_configured"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    status.show();
  };

  /** Settings or credentials changed: re-register and forget the old verdict. */
  const changed = (): void => {
    lastDoctor = undefined;
    didChange.fire();
    void refreshStatus();
  };

  // ---------------------------------------------------------------------------
  // MCP server definition
  // ---------------------------------------------------------------------------

  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: didChange.event,
    // Definitions are cached by VS Code, so they never carry secrets: the
    // credentials are added in resolveMcpServerDefinition, at start time.
    provideMcpServerDefinitions: async () => {
      const settings = readSettings();
      const creds = await readCredentials();
      const version = definitionVersion(settings, creds, revision());
      if (settings.transport === "http") {
        return [
          new vscode.McpHttpServerDefinition(
            SERVER_LABEL,
            vscode.Uri.parse("http://127.0.0.1/mcp"),
            {},
            version,
          ),
        ];
      }
      const launch = serverLaunch();
      const def = new vscode.McpStdioServerDefinition(
        SERVER_LABEL,
        launch.command,
        launch.args,
        {},
        version,
      );
      return [def];
    },
    resolveMcpServerDefinition: async (server) => {
      const env = await serverEnv();
      if (server instanceof vscode.McpHttpServerDefinition) {
        const handle = await http.start(env);
        server.uri = vscode.Uri.parse(handle.url);
        server.headers = { ...server.headers, ...handle.headers };
        return server;
      }
      if (server instanceof vscode.McpStdioServerDefinition) {
        server.env = { ...server.env, ...env };
      }
      return server;
    },
  };

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  const signIn = async (): Promise<void> => {
    const instance = await vscode.window.showInputBox({
      title: "ServiceNow MCP: Sign In (1/3)",
      prompt: "Instance name, host or URL",
      placeHolder: "dev12345 or dev12345.service-now.com",
      ignoreFocusOut: true,
      validateInput: validateInstance,
    });
    if (instance === undefined) return;

    const methods: (vscode.QuickPickItem & { method: SignInMethod })[] = [
      {
        label: "Basic",
        description: "user name + password",
        method: "basic",
      },
      {
        label: "API key",
        description: "ServiceNow Inbound API key (x-sn-apikey)",
        method: "apikey",
      },
      {
        label: "OAuth client credentials",
        description: "Application Registry client id + secret",
        method: "oauth",
      },
      {
        label: "Bearer token",
        description: "a pre-obtained access token",
        method: "token",
      },
    ];
    const picked = await vscode.window.showQuickPick(methods, {
      title: "ServiceNow MCP: Sign In (2/3)",
      placeHolder:
        "Authentication method (for OAuth Authorization Code + PKCE, run `npx servicenow-mcp-ai login` in a terminal)",
      ignoreFocusOut: true,
    });
    if (!picked) return;

    let user: string | undefined;
    let clientId: string | undefined;
    if (picked.method === "basic") {
      user = await vscode.window.showInputBox({
        title: "ServiceNow MCP: Sign In (3/3)",
        prompt: "User name",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Enter the user name."),
      });
      if (user === undefined) return;
    }
    if (picked.method === "oauth") {
      clientId = await vscode.window.showInputBox({
        title: "ServiceNow MCP: Sign In (3/3)",
        prompt: "OAuth client id",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Enter the client id."),
      });
      if (clientId === undefined) return;
    }
    const secretLabel = {
      basic: "Password",
      apikey: "API key",
      oauth: "OAuth client secret",
      token: "Bearer token",
    }[picked.method];
    const secret = await vscode.window.showInputBox({
      title: "ServiceNow MCP: Sign In (3/3)",
      prompt: `${secretLabel} — stored in VS Code SecretStorage, never in settings or on disk by this extension`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? undefined : `Enter the ${secretLabel}.`),
    });
    if (secret === undefined) return;

    const creds: StoredCredentials = {
      instance: instance.trim(),
      method: picked.method,
      secret,
      ...(user !== undefined ? { user: user.trim() } : {}),
      ...(clientId !== undefined ? { clientId: clientId.trim() } : {}),
    };
    await context.secrets.store(SECRET_KEY, JSON.stringify(creds));
    await context.globalState.update(REVISION_KEY, revision() + 1);
    changed();
    const action = await vscode.window.showInformationMessage(
      `ServiceNow MCP: signed in to ${describeCredentials(creds)}. The server picks this up on its next start.`,
      "Run Doctor",
    );
    if (action === "Run Doctor") {
      await vscode.commands.executeCommand("servicenowMcp.runDoctor");
    }
  };

  const signOut = async (): Promise<void> => {
    const creds = await readCredentials();
    await context.secrets.delete(SECRET_KEY);
    await context.globalState.update(REVISION_KEY, revision() + 1);
    changed();
    void vscode.window.showInformationMessage(
      creds
        ? `ServiceNow MCP: signed out of ${creds.instance}. The stored secret was removed.`
        : "ServiceNow MCP: no stored sign-in to remove.",
    );
  };

  let doctorRunning = false;
  const runDoctor = async (): Promise<void> => {
    if (doctorRunning) {
      output.show(true);
      return;
    }
    doctorRunning = true;
    status.text = "$(sync~spin) ServiceNow: doctor…";
    try {
      const env = await serverEnv();
      const launch = serverLaunch(["doctor", "--json"]);
      output.appendLine(
        `[${new Date().toISOString()}] ${launch.command} ${launch.args.join(" ")}`,
      );
      const run = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "ServiceNow MCP: running doctor",
        },
        () =>
          new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number | null;
          }>((resolve) => {
            let stdout = "";
            let stderr = "";
            const child = spawn(launch.command, launch.args, {
              shell: launch.shell,
              env: { ...process.env, ...env, SN_LOG_LEVEL: "error" },
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });
            const timer = setTimeout(() => child.kill(), DOCTOR_TIMEOUT_MS);
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (c: string) => (stdout += c));
            child.stderr.on("data", (c: string) => (stderr += c));
            child.once("error", (error) => {
              clearTimeout(timer);
              resolve({
                stdout,
                stderr: `${stderr}\n${error.message}`,
                exitCode: null,
              });
            });
            child.once("close", (code) => {
              clearTimeout(timer);
              resolve({ stdout, stderr, exitCode: code });
            });
          }),
      );
      lastDoctor = summarizeDoctor(run);
      output.append(lastDoctor.text);
      const show = "Show Output";
      const signInAction = "Sign In";
      const actions =
        lastDoctor.status === "not_configured" ? [signInAction, show] : [show];
      const notify =
        lastDoctor.status === "healthy"
          ? vscode.window.showInformationMessage
          : lastDoctor.status === "degraded"
            ? vscode.window.showWarningMessage
            : vscode.window.showErrorMessage;
      void notify(lastDoctor.headline, ...actions).then((choice) => {
        if (choice === show) output.show(true);
        if (choice === signInAction) {
          void vscode.commands.executeCommand("servicenowMcp.signIn");
        }
      });
    } finally {
      doctorRunning = false;
      await refreshStatus();
    }
  };

  /** Multi-select the tool packages; writes `servicenowMcp.packages`. */
  const selectPackages = async (): Promise<void> => {
    const pkgJson = context.extension.packageJSON as {
      contributes?: {
        configuration?: {
          properties?: Record<
            string,
            { items?: { enum?: string[]; enumDescriptions?: string[] } }
          >;
        };
      };
    };
    const items =
      pkgJson.contributes?.configuration?.properties?.[
        `${SETTINGS_SECTION}.packages`
      ]?.items;
    const names = items?.enum ?? [];
    const descriptions = items?.enumDescriptions ?? [];
    const current = new Set(readSettings().packages);
    const picked = await vscode.window.showQuickPick(
      names.map((name, i) => ({
        label: name,
        description: descriptions[i],
        picked: current.has(name),
      })),
      {
        title: "ServiceNow MCP: tool packages",
        placeHolder: "Nothing selected = the server default (core)",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked) return;
    await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(
      "packages",
      picked.map((p) => p.label),
      vscode.ConfigurationTarget.Global,
    );
  };

  const tryFirstPrompt = async (): Promise<void> => {
    await vscode.commands.executeCommand("workbench.action.chat.open", {
      query:
        "Using ServiceNow, run servicenow_test_connection, then list the 5 most recent active incidents with their priority.",
      isPartialQuery: true,
      mode: "agent",
    });
  };

  /** N-52: copy the bundled Agent Skills into a workspace skills folder. */
  const addSkills = async (): Promise<void> => {
    const source = skillsSource(context.extensionPath);
    if (!source) {
      void vscode.window.showErrorMessage(
        "ServiceNow MCP: this build of the extension carries no skills.",
      );
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage(
        "ServiceNow MCP: open a folder first; the skills are copied into the workspace.",
      );
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "ServiceNow MCP: trust the workspace before adding skills to it.",
      );
      return;
    }
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Workspace folder to add the skills to",
          });
    if (!folder) return;
    const pick = await vscode.window.showQuickPick(
      SKILL_TARGETS.map((t) => ({
        label: t.folder,
        description: `read by ${t.description}`,
      })),
      { title: "ServiceNow MCP: skills folder", ignoreFocusOut: true },
    );
    if (!pick) return;
    const target = vscode.Uri.joinPath(folder.uri, pick.label).fsPath;
    const plan = planSkillCopy(source, target);
    let overwrite = false;
    if (plan.existing.length > 0) {
      const replace = "Replace";
      const keep = "Keep Mine";
      const choice = await vscode.window.showWarningMessage(
        `${plan.existing.join(", ")} already exist in ${pick.label}.`,
        { modal: true },
        replace,
        keep,
      );
      if (!choice) return;
      overwrite = choice === replace;
    }
    const written = copySkills(source, target, overwrite);
    output.appendLine(
      `[${new Date().toISOString()}] skills -> ${target}: ${written.join(", ") || "none"}`,
    );
    void vscode.window.showInformationMessage(
      written.length > 0
        ? `ServiceNow MCP: added ${written.length} skills to ${pick.label}.`
        : `ServiceNow MCP: ${pick.label} already has every skill.`,
    );
  };

  context.subscriptions.push(
    output,
    didChange,
    status,
    { dispose: () => http.stop() },
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider),
    vscode.commands.registerCommand("servicenowMcp.signIn", signIn),
    vscode.commands.registerCommand("servicenowMcp.signOut", signOut),
    vscode.commands.registerCommand("servicenowMcp.runDoctor", runDoctor),
    vscode.commands.registerCommand(
      "servicenowMcp.selectPackages",
      selectPackages,
    ),
    vscode.commands.registerCommand(
      "servicenowMcp.tryFirstPrompt",
      tryFirstPrompt,
    ),
    vscode.commands.registerCommand("servicenowMcp.addSkills", addSkills),
    vscode.commands.registerCommand("servicenowMcp.showOutput", () =>
      output.show(),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SETTINGS_SECTION)) changed();
    }),
    // A sign-in or sign-out in another window shares the same SecretStorage.
    context.secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) changed();
    }),
  );

  void refreshStatus();
}

export function deactivate(): void {
  // Everything (including the http server process) is disposed via
  // context.subscriptions.
}
