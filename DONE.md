# Sincronia — Готово (DONE)

Завършена и верифицирана работа, изнесена от ревютата и плана. Активните, още неизпълнени задачи са в [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), [TODO-code-review.md](TODO-code-review.md) и [TODO-architecture-review.md](TODO-architecture-review.md).

Състояние: build чист · ESLint чист · 59/59 `node:test` (вкл. mock-fetch, OAuth, packages, batch, plugin API-та, scripts, docs, diagrams) · GitHub Actions CI.

## Базова функционалност

- [x] 7 tool-а върху Table API: `query_table`, `get_record`, `create_record`, `update_record`, `delete_record`, `set_credentials`, `get_status`.
- [x] ServiceNow Table API клиент (`fetch` + Basic auth), stdio транспорт (само `stderr` лог), `.env` конфигурация с runtime обновяване.

## Код ревю (TODO-code-review.md)

- [x] Грешките логват само хост + път, без query string (`safeUrl`).
- [x] dotenv round-trip на `formatEnvValue` (single-quote / отказ при несериализуеми стойности) + покрит с тест.
- [x] Error detail верига с `||` + fallback `"(no detail)"` (`extractErrorDetail` → `res.statusText` → `text`).
- [x] Валидация на `data.result` (масив/обект) → смислена `ServiceNowError` вместо `TypeError`.
- [x] `cause instanceof Error` в fetch catch-а; `json: unknown` + type guard.
- [x] Версия от `package.json` (`createRequire`) — единен източник.
- [x] `SN_TIMEOUT_MS` и всички `SN_*` документирани в README + `.env.example`.
- [x] `shuttingDown` guard срещу повторен SIGINT/SIGTERM.
- [x] Атомарен `.env` запис (временен файл + `renameSync`).
- [x] `X-Total-Count` → `total` в query резултата (`{ count, total, records }`).
- [x] Unit тестове (`node:test`): `formatEnvValue` round-trip, `_buildBaseUrl` SSRF/allow-list — `npm test`.
- [x] ESLint (flat config + typescript-eslint) + Prettier — `npm run lint` / `npm run format`.
- [x] Несъответствие папка/пакет (`sincronia-mpc` vs `sincronia-mcp`) — документирано в README.

## Архитектурно ревю (TODO-architecture-review.md)

- [x] Rate limiting и retry: exponential backoff + `Retry-After` (429/502/503/504; мутации само при connect грешки); `SN_MAX_RETRIES`.
- [x] Версионирането — единен източник от `package.json` (`createRequire`); вече не се дублира.
- [x] **OAuth 2.0 + `AuthProvider` интерфейс** (`auth.ts`): Basic и OAuth (password / client*credentials / refresh_token) са взаимозаменяеми; токенът се кешира до изтичане. `SN_AUTH`, `SN_OAUTH*\*`.
- [x] **Allowlist/denylist на таблици + read-only режим** (`policy.ts`): `SN_TABLES_ALLOW`, `SN_TABLES_DENY`, `SN_READONLY` — налагани в клиентския слой (defense in depth).
- [x] **Tool annotations** на всички инструменти: `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.
- [x] **Структуриран error payload** от `fail()`: `{ error: { message, status, snDetail } }` вместо плосък текст.
- [x] **MCP resources**: `servicenow://status`, `servicenow://tables`, `servicenow://schema/{table}`.
- [x] **Structured logging на stderr** с `SN_LOG_LEVEL` (`logging.ts`); без тайни и без raw заявки в логовете.
- [x] **Рефактор на `index.ts`**: тънък bootstrap + `registry.ts` + `tools/<група>.ts`; общ HTTP клиент `http.ts`, разделени `host.ts` / `settings.ts` / `errors.ts` / `result.ts`.
- [x] **Местоположение на env файла**: env-first (`override:false`) + XDG (`~/.config/sincronia-mcp/.env`) + `SN_ENV_FILE`; атомарен запис с създаване на директорията.
- [x] **Тестова пирамида**: unit + mock-fetch тестове (`http.test.js`, `auth.test.js`: error mapping, retry на 429, Basic/Bearer хедъри, policy, структуриран `fail`) + GitHub Actions CI (build + lint + test).

## Разширен API обхват

- [x] **Aggregate (Stats) API** (`api/aggregate.ts` + `servicenow_aggregate`): count/avg/min/max/sum + group_by + having.
- [x] **Attachment API** (`api/attachment.ts` + 5 инструмента): list / get / upload (base64) / download (base64, size-guard) / delete.
- [x] **Import Set API** (`api/importset.ts` + 2 инструмента): insert на staging ред + четене на резултата от трансформацията.
- [x] **Метаданни** (`api/meta.ts` + `servicenow_list_tables` / `servicenow_describe_table`): `sys_db_object` и `sys_dictionary`.

## План за пълно покритие (IMPLEMENTATION-PLAN.md)

- [x] **Tool packages** (`SN_TOOL_PACKAGES`): групиране на инструментите по пакети с профили `core` (по подразбиране) и `all`; gating в `registry.ts` (`resolveEnabledPackages`), admin инструментите винаги активни, неизвестни имена се игнорират. `get_status` връща `enabledPackages`. Покрито с тестове.
- [x] **Batch API** (`api/batch.ts` + `servicenow_batch`): няколко REST под-заявки в една HTTP заявка; base64 encode/decode на телата; policy се налага per под-заявка (read-only + table allow/deny). Покрито с mock-fetch тестове.
- [x] **Capability detection за plugin API-та** (`api/plugin.ts`): `pluginCall` обвива plugin-зависимите заявки и при 404 добавя ясна подсказка, че съответният API/plugin може да не е активен на инстанцията (вместо подвеждаща грешка).
- [x] **Service Catalog API** (`api/catalog.ts`, пакет `catalog`): `servicenow_list_catalogs`, `servicenow_list_catalog_categories`, `servicenow_list_catalog_items`, `servicenow_get_catalog_item`, `servicenow_order_catalog_item` (write — спазва read-only). Покрито с mock-fetch тестове.
- [x] **Change Management API** (`api/change.ts`, пакет `change`): `servicenow_list_changes`, `servicenow_get_change`, `servicenow_create_change` (normal/standard/emergency; standard изисква `template_id`), `servicenow_update_change`, `servicenow_change_conflicts` (read или recalculate). Покрито с mock-fetch тестове.
- [x] **Knowledge API** (`api/knowledge.ts`, пакет `knowledge`): `servicenow_search_knowledge`, `servicenow_get_knowledge_article`, `servicenow_knowledge_highlights` (featured/most_viewed). Покрито с mock-fetch тестове.
- [x] **CMDB Instance/Meta API** (`api/cmdb.ts`, пакет `cmdb`): `servicenow_list_cis`, `servicenow_get_ci`, `servicenow_create_ci`, `servicenow_update_ci` (през IRE), `servicenow_get_cmdb_meta`; класът се проверява през table allow/deny. Покрито с mock-fetch тестове.
- [x] **Script intelligence** (`api/scripts.ts`, пакет `scripts`, read-only): `servicenow_list_scripts` (по тип: business_rule/script_include/client_script/ui_policy/ui_action/scheduled_job/transform/rest_operation/acl — метаданни без код), `servicenow_get_script` (пълен source + контекст), `servicenow_search_code` (търси в изворния код, връща снипет по ред), `servicenow_table_logic` (цялата автоматика за таблица: BR по when+order, client scripts, UI policies, UI actions, ACL). Покрито с mock-fetch тестове.
- [x] **Самодокументация** (`api/docs.ts` + `api/diagrams.ts`, пакет `docs`): `servicenow_docs_list/read/search/write` — локален MD магазин (SN_DOCS_DIR, default `docs/instance`), защита срещу path traversal, само `.md`, `index.md` се регенерира при запис; `servicenow_generate_er_diagram` (Mermaid `erDiagram` от `sys_dictionary` references) и `servicenow_generate_table_flow` (Mermaid `flowchart` от business rules по фази). Покрито с файлови + mock-fetch тестове.
- [x] **MCP Prompts** (`prompts.ts`, винаги активни): `servicenow_incident_triage`, `servicenow_change_impact_analysis`, `servicenow_document_table` — оркестрират съществуващите tools и настояват всички стойности да се четат от инстанцията.
- [x] **MCP resource `servicenow://docs/{path}`** (`resources.ts`): чете MD файл от локалния docs магазин като text/markdown.

## Допълнителни подобрения (извън ревютата)

- [x] SSRF guard: `resolveHost` блокира internal/loopback хостове + `SN_ALLOWED_HOSTS` allow-list.
- [x] Пагинация `fetchAll` + лимит `SN_MAX_RECORDS`.
- [x] Result size guard `SN_MAX_RESULT_CHARS` (отрязва прекалено голям резултат).
