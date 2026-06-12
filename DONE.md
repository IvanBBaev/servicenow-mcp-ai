# Sincronia — Готово (DONE)

Завършена и верифицирана работа, изнесена от ревютата и плана. Активните, още неизпълнени задачи са в [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) и [TODO.md](TODO.md); хронологията на работата — в [WORKLOG.md](WORKLOG.md).

Състояние: build чист · ESLint чист (type-checked) · 107/107 `node:test` (вкл. mock-fetch, OAuth, packages, batch, plugin API-та, scripts, docs, diagrams, MCP smoke, README sync) · GitHub Actions CI · git хранилище с commit-по-задача история · **ревюто от 2026-06-12 е изцяло имплементирано (22/22)**.

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

## Дълбоко ревю 2026-06-12 — имплементирани находки (по един commit на задача)

Пълните описания на находките са в WORKLOG.md (подробно) и в git историята; тук е резюмето.

### Синиър дев (S)

- [x] **S-1 (критично) + S-2** · `describe_table` обхожда веригата на наследяване (`sys_db_object.super_class`, dot-walk, цикъл-guard) — за `incident` се виждат и полетата от `task`; дете-override печели; нова колона `sourceTable`; `listTables` връща истинско име на родителя. _(commit 9d8da51)_
- [x] **S-3** · стриктна base64 валидация при upload — `Buffer.from` никога не хвърля, невалидният вход вече е грешка без HTTP заявка. _(385fd57)_
- [x] **S-4** · download проверява `size_bytes` от метаданните преди да тегли байтовете (без 1 GB в паметта „за проба“). _(385fd57)_
- [x] **S-5** · `servicenow_aggregate` изисква поне една агрегация — fail-fast офлайн. _(5c31ec7)_
- [x] **S-6** · batch table policy покрива и `/stats`, `/import`, `/cmdb/instance` под-заявки. _(6ad6821)_
- [x] **S-7** · `invalidateTokens()` — OAuth кешът се чисти при смяна на креденшъли (ключът не съдържа паролата). _(946ea2d)_
- [x] **S-8** · `search_code` логва дължина на текста, не самия текст. _(70a961d)_

### Архитект (A)

- [x] **A-1** · per-package policy: `SN_PACKAGES_DENY` (маха цял пакет, вкл. plugin API-та, които table policy не вижда) + `SN_PACKAGES_READONLY` (регистрира само read tools през Proxy фасада по `readOnlyHint`); `effectivePackages()` — общ източник за registry и status; README предупреждава, че table deny ≠ plugin deny. _(90668d3)_
- [x] **A-2** · ConfigStore: креденшълите са атомарен in-memory snapshot в `config.ts` — env-ът е само начален източник; `saveCredentials` сменя snapshot-а с едно присвояване (недовършено четене е структурно невъзможно); `reloadCredentialsFromEnv()` за startup/тестове. Опорна точка за MI-1 профилите. _(290a346)_
- [x] **A-8** · README tools таблицата се генерира: `registry.ts#describeAllTools()` (replay срещу capturing stub) → `scripts/readme-tools.mjs` (`npm run docs:readme`) → секция между GENERATED маркери; `test/readme-sync.test.js` пада при изоставане. Остава ръчна само env таблицата (целта на М-5 е сведена до нея). _(5bd5489)_
- [x] **A-3** · capability кеш в `pluginCall`: namespace 404 („does not represent any resource“) се кешира 5 мин с мигновен отказ; record 404 не се кешира; наличността е в `pluginApis` на status-а. _(3cd86cb)_
- [x] **A-4** · `api/shared.ts: expectResult/expectResultArray` — 7-те копия на result-проверката станаха едно. _(da3f056)_
- [x] **A-5** · един `buildStatusPayload()` (`src/status.ts`) за tool-а и resource-а — разминаването е невъзможно. _(4028969)_
- [x] **A-6** · `noUncheckedIndexedAccess` в tsconfig; 6 файла поправени с истински guard-ове. _(021cfa4)_
- [x] **A-7** · type-checked ESLint + `no-floating-promises`; `no-base-to-string` хвана реален капан → нов `snString()` (обект при `display_value=all` вече не става `"[object Object]"`). _(42e1d5f)_

### QA (Q)

- [x] **Q-1 + Q-4** · in-memory MCP smoke тестове: истински SDK `Client`+`McpServer` през `InMemoryTransport` — контрактен snapshot на core профила (15 tools), zod → мапинг → ok()/fail() пликове, package gating, status resource. _(f13f316)_
- [x] **Q-2** · общ `test/helpers.js` (baselineEnv/withEnv/withFetch/jsonResponse); 6-те стари файла мигрирани, ~150 реда дублиране махнати. _(edcd07b)_
- [x] **Q-3** · 17 теста за непокритото: fetchAll пагинация + SN_MAX_RECORDS cap, okQueryResult truncation, retry матрицата (GET/POST, Retry-After като дата), pluginCall, settings парсери. _(b6469f1)_
- [x] **Q-5** · env override тестове (settings) + SN_LOG_LEVEL филтър тестове. _(b6469f1, be291e6)_
- [x] **Q-6** · тест дисциплината е институционализирана: правило 7 в плана (раздел 6.6) + три автоматични пазача — README sync тестът, контрактният snapshot на core профила и пълният suite. Недисциплинирана промяна чупи поне един от тях.

### Покрай ревюто

- [x] **П-1** · `git init` + baseline; една задача = един commit (16 commit-а за ревюто). _(2424fcf)_
- [x] Авто-одобрение на повтарящите се dev команди в `.claude/settings.json` (build/lint/test/commit; без push и широки wildcard-и).
- [x] **CHANGELOG.md** създаден (Keep a Changelog, `[Unreleased]` обобщава цялото текущо състояние) — затваря стария опционален елемент „Changelog при публикуване“.
- [x] Старите опционални точки от архитектурното ревю 2026-06-11 са пренесени в плана: trust boundary → Х-2 (elicitation), MCP logging capability → Х-4, PDI integration suite + Export API → секция „Опционално“; roadmap елементът е изчерпан (Batch/Catalog/Knowledge/CMDB/IRE покрити, Email е Х-7).

## Фаза 6 (Харнес 2.0) — завършени задачи

### Предпоставки и одит

- [x] **П-1 · git init** + baseline; история commit-по-задача. _(2424fcf)_
- [x] **П-2 · Node 20+ защита на три нива**: CJS launcher (`bin/sincronia-mcp.cjs`) с guard преди парсването на ESM графа, втори guard в index.ts, `engines >=20` + `.npmrc engine-strict`. Проверено под истински Node 12. _(2a84eb3)_
- [x] **Х-1 · SDK ъпгрейд 1.12 → 1.29** — констатиран готов при одита на 2026-06-12; InMemoryTransport вече се ползва от smoke тестовете.
- [x] **Х-3 · Prompts модул** — `src/prompts.ts` с трите шаблона (triage / change impact / document table), реализиран с Фаза 4/5.

### Коректност (К-серията, изцяло)

- [x] **К-1 · OAuth 401 → инвалидация + еднократен retry** с нов токен; второ 401 е истинска грешка. _(b48a4f1)_
- [x] **К-2 · Authorization per attempt** — токен не изтича между backoff опитите. _(b48a4f1)_
- [x] **К-3 · Стабилна fetchAll пагинация** — автоматичен `ORDERBYsys_id` при заявка без подредба. _(61cbd26)_
- [x] **К-4 · Batch само `/api/` пътища** — `/oauth_token.do`, `/login.do` и пр. недостъпни. _(b10a50c)_
- [x] **К-5 · `^` във филтрите на search/list се отхвърля** (encoded-query разделител без escape). _(ff3e826)_
- [x] **К-6 · `set_credentials` валидира хоста (resolveHost) преди запис** — нищо не се персистира при невалиден. _(d0e2822)_
- [x] **К-7 · Resources следват пакетната политика** (schema/docs пакети; status винаги). _(07006b5)_
- [x] **К-8 · CI Node матрица 20/22/24 + c8 coverage**; `npm test` без дублиран build (`test:full` за локално). _(5002c2d)_

### Модулизация и нови възможности

- [x] **М-5 · Генерирана README tools таблица** — `describeAllTools()` + `scripts/readme-tools.mjs` + sync тест (виж A-8 по-горе); остатък: env таблицата.
- [x] **М-6 · Snapshot на манифеста** — `{name, package, title, annotations}` за всички tools срещу чекирана фикстура (`npm run gen:manifest`). _(ae7d123)_
- [x] **Х-6 · `servicenow_test_connection`** — чете 1 запис от sys_user, връща `{ok, status, latencyMs, user}`; 401/403/timeout структурирано, не като exception. _(373688b)_

### Оптимизации (О-серията, изцяло)

- [x] **О-1 · `sysparm_exclude_reference_link=true` по подразбиране** (opt-out `SN_INCLUDE_REF_LINKS`) — −20–40% токени при reference-тежки отговори. _(05b0341)_
- [x] **О-2 · Компактен JSON изход** (opt-in `SN_RESULT_PRETTY`) — pretty ~удвояваше токените. _(05b0341)_
- [x] **О-3 · Схема-кеш с TTL** (`SN_SCHEMA_CACHE_TTL_SEC`, default 300 s; ключ с instance) за list_tables/describe_table/get_cmdb_meta. _(103ab7f)_
- [x] **О-4 · Семафор `SN_MAX_CONCURRENT`** (default 4) около fetch. _(84ccbb5)_
- [x] **О-5 · Телеметрия** `{requests, retries, errors, totalMs}` в get_status и servicenow://status. _(84ccbb5)_

### Модулизация (М-серията, изцяло) — следобедният спринт

- [x] **М-1 · Директории `core/` / `api/` / `mcp/` / `tools/`** — слоеста структура с еднопосочни зависимости; чист git mv + 56 пренаписани import пътя; нула промяна в поведение. _(5e6cd04)_
- [x] **М-2 · ESLint граници на слоевете** (no-restricted-imports зони: core⇍api/mcp/tools; api⇍mcp/tools; tools⇍core/http) + `api/diagnostics.ts` (test_connection логиката извадена от tools). Нарочен грешен import гърми на lint — проверено. _(ab6c252)_
- [x] **М-3+М-4 · Декларативен tool манифест** — `mcp/define.ts` (ToolSpec + defineTool + runSpec, погълнал tools/util), 13-те tools файла пренаписани като `specs: AnyToolSpec[]`, `ALL_TOOLS` в registry (пакет = един spread), readonly пакети = филтър по annotations (Proxy фасадата изтрита), describeAllTools чете манифеста директно. Контрактът байт-идентичен (snapshot тестовете минаха без регенерация). _(71b6058)_

### Нови възможности (Х-серията) — следобедният спринт

- [x] **Х-7 · Email пакет** — api/email.ts + tools/email.ts (send/get, pluginCall, write policy); включване = 1 import + 1 spread; 49 tools / 14 пакета. _(5f95db9)_
- [x] **Х-2 · Elicitation за set_credentials** — клиент с elicitation capability потвърждава промяната (decline → нищо не се записва); без capability → старото поведение. _(f15bb5d)_
- [x] **Х-4 · MCP logging capability** — `setLogSink` в core/logging + `sendLoggingMessage` огледало след connect; гърмящ sink се гълта. _(f15bb5d)_
- [x] **Х-5 · outputSchema + structuredContent** — `ToolSpec.output` / `okStructured()`; приложено на get_status и test_connection. Отклонение от плана: query_table/get_record/aggregate нарочно без — дублирането на structuredContent противоречи на О-2. _(f15bb5d)_

**Оставащо от Фаза 6:** само **Х-8** (HTTP транспорт) — изрично опционален („само при нужда от отдалечен достъп“). **Фаза 6 е завършена.**
