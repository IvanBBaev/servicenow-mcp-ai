# Sign in to your instance

Run **ServiceNow MCP: Sign In** and answer three prompts:

1. **Instance** — a name (`dev12345`), a host (`dev12345.service-now.com`) or an
   `https://` URL.
2. **Method** — how the server authenticates:
   - **Basic** — user name and password.
   - **API key** — a ServiceNow REST API key.
   - **OAuth client credentials** — an OAuth application's client id and secret.
   - **Bearer token** — a token you obtained elsewhere.
3. **Secret** — the password, key, client secret or token.

## Where the secret goes

The instance, the method and the secret are stored in VS Code **SecretStorage**
(the operating system keychain). They are never written to your settings, to the
workspace or to an env file. When VS Code starts the server, the extension passes
them to the server process as environment variables only.

A sign-in takes precedence over the values in your env file. **ServiceNow MCP:
Sign Out** removes the stored secret; the server then falls back to the env file.

## Browser (PKCE) sign-in

Interactive OAuth with a browser is handled by the server's own CLI. Run it once
in a terminal:

```sh
npx servicenow-mcp-ai login
```

It stores the tokens in the server's env file, so do not sign in here as well.
