# ServiceNow AI Control Tower — analysis for servicenow-mcp-ai

Date: 2026-10-30 · Baseline: main @ 5810e25 · servicenow-mcp-ai 3.0.0.
Companion to [COMPETITIVE-ANALYSIS.md](COMPETITIVE-ANALYSIS.md) (2026-06, which mentions AICT
only as "the governance behind the MCP Server Console") and
[ROLE-REVIEW-2026-10.md](ROLE-REVIEW-2026-10.md) (N-109 audit journal, N-134 `regulated`
preset). Findings use the prefix `CT-`. No roadmap rows are minted here; §7 lists candidates
for the owner.

**Evidence level.** Everything about AICT comes from ServiceNow press releases and
ServiceNow Community product articles (sources in §9). They describe intended capability, not
independently verified behaviour. The PDI (`ven03019`) could not confirm anything: a read of
`sys_store_app` returned 403 for the configured user, and AICT needs a licensed instance
anyway (same blocker as O-25).

## 1. Summary

1. **AICT is no longer "governance for ServiceNow's own AI".** Since Knowledge 2026 (May 5)
   and the August/September 2026 GA wave it inventories, observes, governs, secures and meters
   AI **anywhere** in the enterprise — hyperscalers, Anthropic, OpenAI, Microsoft Agent 365,
   Salesforce, Databricks — and **MCP servers are a first-class governed asset type**.
2. **AI Gateway 3.4 (GA 2026-09-10) is the enforcement point for MCP.** Approved servers are
   reached only through a ServiceNow-hosted gateway URL with short-lived OAuth 2.1 tokens,
   OWASP-MCP-Top-10 tool scanning, per-tool data-sensitivity blocking, global/per-server pause
   and per-tool telemetry.
3. **For this project this is both a threat and a channel.** In an AICT customer, an
   ungoverned, locally run stdio server with basic-auth credentials is exactly the "shadow
   AI" AICT is sold to find and block. The same customer is reachable if servicenow-mcp-ai
   can be **registered, scanned, approved and fronted** by AI Gateway — i.e. run in HTTP mode
   as a governable remote MCP server.
4. **Durable moats are unchanged** (multi-instance, code intelligence, any instance incl. PDI,
   no Assist-currency cost). The positioning claim "client-side governance where there is no
   AI Control Tower" (`src/core/write-journal.ts`, CHANGELOG DF-2) gets weaker: where AICT
   exists, the enterprise expects our audit and telemetry to flow **into** it, not to replace it.

## 2. What AI Control Tower is (state on 2026-10-30)

| Pillar                   | Capabilities (vendor-stated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discover / inventory** | AI asset types: systems, models, agents, datasets, prompts, **MCP servers**. Managed vs Unmanaged state (only Stewards change it); automated "make Managed" rules (10 max, 5 active). Models and systems as CSDM-aligned CMDB CIs with lifecycle. Service Graph connectors: AWS, Azure, GCP (tenant-level), Salesforce, Databricks, Snowflake, Hugging Face, **Anthropic, OpenAI, Moveworks, Microsoft Agent 365**; agent auto-discovery from observability logs; LLM-assisted de-duplication; an Inventory Enrichment Agent that scores metadata completeness. AI Asset APIs expose metadata, lifecycle, risk and controls. |
| **Observe**              | Trace collectors for CloudWatch, Azure Foundry / App Insights, Vertex AI, and anything instrumented with the **Traceloop (OpenLLMetry / OpenTelemetry) SDK** — Traceloop was acquired. Runtime LLM-as-judge evaluation of every agent run (step, tool, output), per-metric sampling.                                                                                                                                                                                                                                                                                                                                         |
| **Govern**               | Risk-based intake (High/Medium/Low from use and purpose), AI Steward approval playbooks, change and offboarding workflows, continuous control monitoring, compliance content packs (EU AI Act, California, Colorado; NIST AI RMF mapping; ISO 42001 pending), BYOK model-provider governance, anonymous misuse reporting.                                                                                                                                                                                                                                                                                                    |
| **Secure**               | Veza-powered agent access maps (non-human identities, privileged/dormant), design-time model scanning and red-team imports (HiddenLayer, Cisco, Palo Alto), runtime guardrails via an AICT agent SDK, post-runtime OWASP LLM checks, security score with escalation to SIR, a **kill switch** that revokes credentials via Okta and stops agents (ServiceNow, GCP, Bedrock).                                                                                                                                                                                                                                                 |
| **Measure**              | Cost attribution for Assist consumption and **non-ServiceNow token spend**, per asset / user / department (chargeback); "AI Net Return" ROI framework.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

UI: AICT 2.0 "AI Native" workspace, Otto assistant inside AICT, product-owner persona.
Availability: K26 enhancements in Innovation Lab May 2026, GA August 2026; platform release
Australia rolling from April 2026. Pricing is not public (a third-party guide mentions a free
first-year trial).

### 2.1 The MCP-specific layer

| Piece                  | What it does                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MCP Registry**       | Private per-company catalog on the open MCP Registry API. One "Server Card" per server (tools, resources, endpoint, approval status); metadata only, no credentials. Third-party clients (Claude, Copilot, Cursor) **see only approved servers**; ServiceNow-native clients see unapproved ones as not callable.                                                   |
| **Registration paths** | Auto-discovery from AI Agent Studio, the MCP Server Console, import from the built-in MCP catalog (prefills URL, auth type, tools), or manual entry by a Steward / Product Owner.                                                                                                                                                                                  |
| **Lifecycle**          | New → In Review → Approved → Active/Deployed → Deprecated, via the Asset Approval Playbook. Unapproved servers are blocked at build time in AI Agent Studio.                                                                                                                                                                                                       |
| **AI Gateway 3.4**     | Envoy data plane (was Spring Boot). Clients connect to the gateway URL; it verifies agent identity, issues scoped short-lived **OAuth 2.1** tokens, stores and rotates the upstream server credentials centrally. Client types: plain MCP client and **CIMD** (Client ID Metadata Document) registration. Named clients: AI Agent Studio, Copilot Studio, VS Code. |
| **Tool scanning**      | Pre-activation scan of tool metadata against **OWASP MCP Top 10** (status Completed / Failed / Pending / Timeout); by default vulnerable tools are auto-deactivated and new tools of an approved server auto-activated. Runtime **Data Sensitivity Check** blocks a whole response that contains a configured data type (PII, credentials), per server or tool.    |
| **Runtime control**    | Global or per-server pause, no code change, one-click restore.                                                                                                                                                                                                                                                                                                     |
| **Telemetry**          | Captured at the gateway: success rate, P50/P90/P95 latency per tool, connection attempts per server and client identity.                                                                                                                                                                                                                                           |

## 3. Where servicenow-mcp-ai stands against it

| AICT expectation                           | servicenow-mcp-ai 3.0.0 today                                                                                                   | Gap                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Remote HTTP endpoint the gateway can front | Streamable HTTP (`SN_TRANSPORT=http`), loopback by default                                                                      | Usable; no documented "behind AI Gateway" deployment                                                        |
| OAuth 2.1 resource server                  | N-17: JWT validation against an issuer's JWKS, RFC 9728 PRM at `/.well-known/oauth-protected-resource` (`src/mcp/http-auth.ts`) | Good fit; untested against the gateway as client                                                            |
| Upstream credentials held by the gateway   | Credentials live in env / secret files; per-user tokens and delegation exist (`src/core/delegation.ts`, `user-tokens.ts`)       | Unclear how the gateway's per-user identity maps to the ServiceNow user the server acts as (CT-04)          |
| Registry entry / Server Card               | Public MCP Registry entry via `server.json` (stdio npm package)                                                                 | No **remote** entry; a Server Card import of a stdio-only package is unlikely to work (CT-03)               |
| Passes OWASP MCP Top 10 tool-metadata scan | Tool descriptions are terse and static; surface scan exists (N-56)                                                              | Never run against the AICT scanner; risk is low but unproven (CT-05)                                        |
| Data Sensitivity Check                     | Client-side `SN_REDACT_FIELDS` / `SN_REDACT_PII`                                                                                | Complementary; a gateway block of a whole response is coarser than our field redaction — document both      |
| Observability into AICT                    | Opt-in OTel bridge (`SN_OTEL=1`, `src/core/otel.ts`), `/metrics`                                                                | Not checked against the OpenLLMetry / GenAI semantic conventions AICT's Traceloop collector expects (CT-06) |
| Audit trail                                | Local per-profile write journal (DF-2, journal v2); N-109 plans an audit-grade journal                                          | No export path into AICT / SIEM; N-109 should name AICT as a target (CT-07)                                 |
| Plan → token → apply                       | Yes, plus elevation                                                                                                             | A real differentiator: the gateway pauses servers but does not make individual writes two-phase             |
| Cost metering                              | None (no Assist cost to meter)                                                                                                  | Not needed; AICT meters the model tokens on the client side                                                 |

## 4. Can AICT stop this server?

**Short answer: not by itself.** AICT makes the server visible; the instance admin and the
client administrator are the ones who can stop it. Derived from vendor descriptions, not
verified on an AICT instance.

**What AICT cannot do directly.**

- AI Gateway pauses, scans and blocks only traffic that goes **through the gateway URL**. A
  stdio or self-hosted HTTP deployment calls the instance's REST API directly with its own
  credentials, so the gateway has nothing to pause.
- The AICT kill switch revokes credentials **through Okta** (and stops ServiceNow, GCP and
  Bedrock agents). A local ServiceNow user with basic auth, or an OAuth client registered on
  the instance itself, is outside that path unless the customer's SSO wires it in.
- Registry approval governs what **ServiceNow-native and registry-aware clients** may call; it
  does not reach into a process running on a developer's machine.

**What can stop it in an AICT customer.**

| Vector                                                                                                                                                                                        | Who acts                            | Effect on the server                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Discovery → manual action. Veza maps non-human identities; an integration user with heavy REST traffic can be flagged as an unmanaged AI asset.                                               | AI Steward, then the instance admin | The user is deactivated or loses roles; every call fails with 401/403.     |
| Instance controls (exist without AICT): REST API access policies, the `snc_platform_rest_api_access` requirement, basic auth disabled, IP allowlists, OAuth application revoked, rate limits. | Instance admin                      | Calls fail with 401/403/429. The cheapest and therefore most likely route. |
| Client policy: a centrally managed Claude, VS Code or Copilot that allows only MCP servers from the approved registry.                                                                        | Client / endpoint admin             | The client refuses to load the server; the instance is never involved.     |

**In practice.**

- On a PDI or an instance without AICT nothing changes.
- On an AICT instance the server keeps working until someone decides to stop it via one of
  the vectors above — the same as any unapproved integration, not automatically.
- The way to stay running is to become an approved asset: HTTP mode behind AI Gateway,
  registered and approved by a Steward (AICT-2, AICT-3 in §7). Errors from the vectors above
  already surface as `INSTANCE_HTTP_401` / `INSTANCE_HTTP_403` with a role hint; a hint that
  names REST API access policies and AICT as possible causes would help the user (candidate
  for AICT-2).

## 5. Findings

- **CT-01 — Positioning text is outdated.** COMPETITIVE-ANALYSIS (2026-06) and the site table
  (`docs/index.md` ~L997) treat AICT as governance for the official server only. AICT now
  governs **any** MCP server, including this one. Our messaging should move from "governance
  where there is no AICT" to "governable by AICT, plus write-level safety AICT does not give".
- **CT-02 — Shadow-AI risk for enterprise adoption.** In an AICT customer, a stdio server on a
  developer laptop with basic-auth credentials is discoverable (Veza non-human identities,
  REST traffic of an integration user) and can be blocked by the kill switch or ACL policy.
  Without a governed deployment story the project is limited to PDIs, consultants and
  non-AICT shops.
- **CT-03 — No remote registry identity.** The registry is built on the open MCP Registry
  API, and catalog import prefills URL + auth type + tools. Our `server.json` describes only
  the npm stdio package. A `remotes` entry (or a documented manual-entry recipe with URL,
  OAuth metadata URL and tool list) is what a Steward needs.
- **CT-04 — Identity chain through the gateway is undefined.** The gateway issues its own
  short-lived tokens to clients and holds the upstream credential. The server then calls
  ServiceNow as _some_ user. Options: (a) one integration user per deployment (simple, loses
  per-user ACLs), (b) gateway-forwarded user identity mapped to a per-user ServiceNow OAuth
  token (keeps ACLs; needs N-17 + delegation to accept the gateway as issuer). Must be decided
  before any "AICT-ready" claim.
- **CT-05 — Tool-scan readiness unproven.** OWASP MCP Top 10 scanning targets tool
  poisoning, over-broad descriptions and instruction-like text. Our descriptions are
  generated and short, but prompts, skills (`skill://`) and resource text are larger
  surfaces. Run our own surface scan (N-56) with the OWASP MCP Top 10 categories as the
  checklist.
- **CT-06 — Telemetry dialect.** AICT ingests traces through the Traceloop SDK (OpenLLMetry).
  If our OTel spans follow the OTel GenAI / MCP semantic conventions, an operator gets
  server-side tool spans in AICT next to the gateway's metrics for free.
- **CT-07 — Audit export.** N-109 (audit-grade journal) and RR-GV findings already ask for
  structured audit events for SIEM. AICT is now the natural SIEM-adjacent consumer for AI
  actions; the event schema should be shaped so it can be shipped there (OTel log or a
  documented JSONL schema).
- **CT-08 — Unique value AICT cannot replace.** Multi-instance drift, script intelligence,
  plan/token/apply writes, field-level redaction and zero entitlement remain outside AICT's
  scope; AICT governs _access to_ tools, not _what a write does_. That is the story to tell
  AICT customers.

## 6. Opportunity — "AICT-ready" deployment

A single deployment mode that an AI Steward can approve:

```
MCP client (Claude, VS Code, Copilot Studio)
   └─► AI Gateway URL  (OAuth 2.1, CIMD, scans, pause, telemetry)
         └─► servicenow-mcp-ai  SN_TRANSPORT=http, SN_HTTP_OAUTH_ISSUER=<gateway/IdP>,
                                SN_HTTP_OAUTH_RESOURCE=<url>, read-only or plan mode,
                                SN_REDACT_PII=1, SN_OTEL=1
               └─► ServiceNow instance(s) via per-user OAuth or a scoped integration user
```

What we would ship: a docs recipe, a `server.json` remote entry, a Server Card-friendly tool
list, an OWASP MCP Top 10 self-check in CI, and an OTel attribute map. No tool-surface change,
so `tools/list` +0 B.

## 7. Candidate roadmap items (owner to accept and number)

| Candidate                                     | Scope                                                                                                             | Effort            | Gate                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------ |
| AICT-1 Positioning refresh                    | CT-01, CT-08: COMPETITIVE-ANALYSIS §2–4, site comparison table, README paragraph. Can fold into N-77.             | S                 | —                                                |
| AICT-2 "Behind AI Gateway" recipe             | CT-02, CT-04: HTTP + OAuth deployment, identity options (a)/(b), recommended env preset. Extends the N-77 recipe. | M                 | O-25 for validation                              |
| AICT-3 Remote registry entry                  | CT-03: `remotes` in `server.json` (or a documented manual-entry card), kept in sync by the version-sync script.   | S                 | owner: do we advertise a remote endpoint at all? |
| AICT-4 OWASP MCP Top 10 self-check            | CT-05: map N-56 surface scan to the ten categories; run in the gate.                                              | S–M               | —                                                |
| AICT-5 OTel GenAI / MCP conventions           | CT-06: align span names and attributes; document Traceloop / AICT ingestion.                                      | S                 | —                                                |
| AICT-6 Audit events consumable by AICT / SIEM | CT-07: fold into N-109 / OD-27 as an explicit target.                                                             | — (part of N-109) | OD-27                                            |

## 8. Owner questions

1. Is an AICT-governed enterprise deployment a target audience for 3.x, or does the project
   stay developer / consultant / PDI-first? (Decides AICT-2 and AICT-3.)
2. Identity model behind the gateway: integration user, per-user OAuth, or both? (CT-04)
3. Is a licensed instance with AICT + AI Gateway obtainable (Innovation Lab, partner
   instance)? Without it every item above stays unverified — same gate as O-25.

## 9. Sources

- ServiceNow Newsroom — [AI Control Tower expansion (K26, 2026-05-05)](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-expands-AI-Control-Tower-to-discover-observe-govern-secure-and-measure-AI-deployed-across-any-system-in-the-enterprise/default.aspx)
- ServiceNow Newsroom — [Opens its full system of action to every AI agent](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-opens-its-full-system-of-action-to-every-AI-Agent-in-the-enterprise/default.aspx)
- ServiceNow Community — [AICT: what's new in the June 2026 release](https://www.servicenow.com/community/ai-control-tower-articles/ai-control-tower-what-s-new-in-the-june-2026-release/ta-p/3561445)
- ServiceNow Community — [What's new in AICT for August & September 2026](https://www.servicenow.com/community/si-control-tower-articles/what-s-new-in-ai-control-tower-for-august-amp-september-2026/ta-p/3597749)
- ServiceNow Community — [What's new in AI Gateway v3.4 (September 2026)](https://www.servicenow.com/community/ai-control-tower-articles/what-s-new-in-ai-gateway-v3-4-september-2026-release/ta-p/3587072)
- ServiceNow Community — [Understanding MCP: how ServiceNow connects, discovers and governs](https://www.servicenow.com/community/workflow-data-fabric-articles/understanding-mcp-how-servicenow-connects-discovers-and-governs/ta-p/3567272)
- ServiceNow Docs — [MCP Registry](https://www.servicenow.com/docs/r/integrate-applications/mcp-registry.html)
- Diginomica — [Knowledge 2026: AI Control Tower expands](https://diginomica.com/servicenow-knowledge-2026-ai-control-tower-expands-autonomous-workforce-reaches-every-function-and)
- The Register — [ServiceNow clears agents for landing](https://theregister.com/2026/05/05/servicenow_clears_agents_for_landing/)
