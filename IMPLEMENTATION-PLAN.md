# Sincronia — План за имплементация: пълно ServiceNow API покритие

Дата: 2026-06-11 · Цел: от 7 tool-а върху Table API → пълноценен ServiceNow MCP сървър, покриващ всичко използваемо от REST повърхността.
Решения от ревютата: `.env` правата и смяната на instance **не са проблеми** (остават както са); обхватът е **максимален**.

---

## Какво предлага ServiceNow (резултат от ресърча)

### Core API-та (налични на всяка инстанция, без plugin)

| API                  | Endpoint                                         | Какво дава                                             |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Table                | `/api/now/table/{table}`                         | CRUD върху всяка таблица — **вече покрито**            |
| Aggregate            | `/api/now/stats/{table}`                         | COUNT/SUM/AVG/MIN/MAX + GROUP BY без да тегли записи   |
| Attachment           | `/api/now/attachment`                            | списък/метаданни/download/upload/delete на файлове     |
| Import Set           | `/api/now/import/{staging}` (+ `insertMultiple`) | правилният начин за bulk вкарване на данни (вкл. CMDB) |
| Batch                | `/api/now/v1/batch`                              | няколко REST заявки в една — пести roundtrips          |
| Email                | `/api/now/email`                                 | изпращане/четене на имейли от инстанцията              |
| CMDB Instance        | `/api/now/cmdb/instance/{class}`                 | CI CRUD + релации, клас-осъзнато                       |
| CMDB Meta            | `/api/now/cmdb/meta/{class}`                     | метаданни/схема на CMDB клас                           |
| Identify & Reconcile | `/api/now/identifyreconcile`                     | правилен CI ingest (IRE) вместо директен insert        |

### Plugin-scoped API-та (изискват активен plugin; откриваме с probe → 404 = няма го)

| API               | Endpoint                                | Какво дава                                                                                        |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Service Catalog   | `/api/sn_sc/servicecatalog`             | браузване на каталози/категории/items, variables, cart, **order now** — невъзможно през Table API |
| Change Management | `/api/sn_chg_rest/change`               | normal/standard/emergency change, **conflict detection**, risk, approvals, CAB                    |
| Knowledge         | `/api/sn_km_api/knowledge`              | търсене на статии с релевантност, featured/most-viewed                                            |
| CSM Case          | `/api/sn_customerservice/case`          | управление на customer service cases                                                              |
| CI/CD             | `/api/sn_cicd`                          | ATF run, app publish/install, scan — за dev инстанции                                             |
| Code Search       | `/api/sn_codesearch/code_search/search` | пълнотекстово търсене в кода на инстанцията (ползва се от VS Code разширението на SN)             |

### Къде живеят скриптовете (достъпни през Table API — нямаме нужда от нов API)

| Таблица                                      | Съдържание                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `sys_script`                                 | Business rules (when/order/condition + script)                         |
| `sys_script_include`                         | Script includes (сървърни библиотеки)                                  |
| `sys_script_client`                          | Client scripts                                                         |
| `sys_ui_policy` / `sys_ui_policy_action`     | UI policies                                                            |
| `sys_ui_action`                              | UI actions (бутони)                                                    |
| `sysauto_script`                             | Scheduled script jobs                                                  |
| `sysevent_script_action`                     | Script actions (event-driven)                                          |
| `sys_ws_operation`                           | Scripted REST API-та                                                   |
| `sys_transform_map` / `sys_transform_script` | Transform maps + скриптовете им                                        |
| `sys_security_acl`                           | ACL-и (вкл. script условия)                                            |
| `wf_workflow` / `wf_activity`                | Legacy workflows                                                       |
| `sys_hub_flow`                               | Flow Designer (JSON дефиниции — четими, но по-трудни за интерпретация) |

> Важно: incident/problem/user/group/агile записите се управляват отлично през съществуващия Table API. Дедикирани API-та добавяме само там, където дават нещо отвъд CRUD (каталог поръчки, change conflicts, KB search, binary attachments).

### Поука от конкурентните MCP сървъри

Echelon-ai-labs (~70 tools) и ShunyaAI (60+) показват: при толкова инструменти LLM контекстът се претоварва и качеството на избора на tool пада. Решението им — **tool packages** (env `SN_TOOL_PACKAGES=core,catalog,change,...`), което приемаме от ден 1.

---

## Архитектура (целево състояние)

```
src/
├── index.ts              # bootstrap: env, server, transport, shutdown
├── config.ts             # credentials (.env) — както е сега
├── http.ts               # shared request(): auth, timeout, retry/backoff, грешки
├── registry.ts           # registerTool wrapper: annotations, ok/fail, package gating
├── tools/
│   ├── table.ts          # 5-те съществуващи CRUD tool-а
│   ├── credentials.ts    # set_credentials + get_status (както са)
│   ├── aggregate.ts
│   ├── attachment.ts
│   ├── import-set.ts
│   ├── batch.ts
│   ├── email.ts
│   ├── cmdb.ts           # instance + meta + identifyreconcile
│   ├── catalog.ts        # sn_sc
│   ├── change.ts         # sn_chg_rest
│   ├── knowledge.ts      # sn_km_api
│   ├── schema.ts         # describe_table (sys_dictionary), list_tables
│   ├── scripts.ts        # четене/търсене на скриптове, table logic
│   └── docs.ts           # самодокументация: read/write/search на MD файлове
└── resources/
    └── status.ts         # connection status като MCP resource
docs/instance/            # генерираната документация на инстанцията (MD + Mermaid)
test/                     # vitest: unit (mock fetch) + env round-trip
```

Принципи:

- Един общ `request()` в `http.ts` — retry, грешки, телеметрия се правят веднъж, всички tool-ове печелят.
- Всеки tools файл експортира `register(server, ctx)`; `index.ts` само ги изброява.
- Всеки tool декларира `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`) и принадлежност към package.

---

> Завършената досега работа е изнесена в отделния файл [DONE.md](DONE.md).

## Фаза 1 — Фундамент за растеж · ~1 ден

> Retry/backoff, unit тестовете и ESLint/Prettier вече са в DONE.

- [x] **Реструктуриране** по схемата по-горе: `http.ts` (изваден `request()`), `registry.ts`, `tools/table.ts`, `tools/admin.ts`. Нула промяна в поведението — чист рефакторинг. (виж DONE.md)
- [x] **Структуриран error payload** от `fail()` (`{ status, message, snDetail }`), за да реагира моделът различно на 401/403/429.
- [x] **Tool annotations** на всички съществуващи tools (query/get → readOnly, delete → destructive, update → idempotent).
- [x] **Tool packages**: env `SN_TOOL_PACKAGES` (профил `core` по подразбиране = table+schema+aggregate+attachment; `all` за всичко; admin инструментите винаги активни). Gating в `registry.ts` (`resolveEnabledPackages`).
- [x] **Mock-fetch тестове + CI**: stub на `globalThis.fetch` за мутации/error mapping/retry; GitHub Actions: build+lint+test.
- [x] Дебъг логване на stderr: tool име, таблица, продължителност, статус (env `SN_LOG_LEVEL`).

## Фаза 2 — Core API-та · ~2 дни

- [x] **Schema tools** (най-голяма печалба за агента): `servicenow_describe_table` (sys_dictionary → полета, типове, задължителни, references) и `servicenow_list_tables` (sys_db_object с филтър). Решава №1 проблем на LLM-а: „какви полета има тази таблица?“
- [x] **Aggregate**: `servicenow_aggregate` — count/sum/avg/min/max + group_by + having върху всяка таблица.
- [x] **Attachment** (5 tool-а): list (по table+sys_id), get (метаданни), download (base64 до лимит), upload (base64), delete (destructive).
- [x] **Import Set**: `servicenow_insert_import_set_row` — POST към staging таблица, връща transform резултата + `servicenow_get_import_set_row`.
- [x] **Batch**: `servicenow_batch` — масив от под-заявки {method, url, body} → една HTTP заявка; base64 encode/decode; policy per под-заявка.
- [ ] **Email**: send/get (зад package `email`, не в default).

## Фаза 3 — CMDB + plugin API-та · ~2–3 дни

- [x] **CMDB пакет**: `servicenow_list_cis`/`get_ci`/`create_ci`/`update_ci` (клас-осъзнато през CMDB Instance API, което минава през IRE) + `servicenow_get_cmdb_meta` (схема на клас). Create/update CI замества голия insert в `cmdb_ci`.
- [x] **Capability detection**: `api/plugin.ts` (`pluginCall`) обвива plugin-зависимите заявки; липсващ plugin → 404 се преобразува в ясно съобщение „API X може да не е активно на тази инстанция“, а не суров 404.
- [x] **Service Catalog пакет** (sn_sc): `list_catalogs`/`list_catalog_categories`/`list_catalog_items`, `get_catalog_item` (+ variables), `order_catalog_item` (order now). Това е флагманската функционалност, която Table API не може.
- [x] **Change Management пакет** (sn_chg_rest): `create_change` normal/standard/emergency, `change_conflicts` (**check conflicts** + recalculate), `list_changes`/`get_change`/`update_change`.
- [x] **Knowledge пакет** (sn_km_api): `search_knowledge` (с релевантност), `get_knowledge_article`, `knowledge_highlights` (featured/most-viewed).
- [ ] (Опционално, по търсене) CSM Case, CI/CD (ATF run за dev инстанции).

## Фаза 4 — MCP UX полиране · ~1 ден

- [x] **Resources**: `servicenow://status` (connection), `servicenow://tables`, `servicenow://schema/{table}` — четими декларативно от клиента, не хабят tool calls.
- [x] **Prompts**: готови шаблони — `servicenow_incident_triage` (триаж на инцидент), `servicenow_change_impact_analysis` (импактен анализ на change), `servicenow_document_table` (документиране на таблица). Регистрират се винаги (като resources).
- [x] **OAuth 2.0** като втори `AuthProvider` (password / client credentials / refresh token) до Basic; env `SN_AUTH=basic|oauth`.
- [x] README преработка: таблица на всички tools, env референция, секция за tool packages, примери.

## Фаза 5 — Script intelligence + самодокументация · ~2 дни

Цел: сървърът да чете и разбира кода на инстанцията и да трупа трайно разбиране в MD файлове с Mermaid диаграми, които следващите сесии ползват като контекст.

### Script intelligence (package `scripts`, read-only)

- [x] `servicenow_list_scripts` — списък по тип (business_rule / script_include / client_script / ui_policy / ui_action / scheduled_job / transform / rest_operation / acl), филтри по таблица, име, active; връща метаданни (when, order, condition, последна промяна, автор), без кода — пести контекст.
- [x] `servicenow_get_script` — пълният source на скрипт + execution контекстът му (за business rule: таблица, when, order, condition, филтър; за script include: client_callable, access).
- [x] `servicenow_search_code` — търсене на стринг/израз във всички script таблици (encoded query `LIKE`); връща сниппет по ред вместо целия скрипт. Отговаря на „къде се ползва този script include?“. (Code Search plugin-ът остава бъдеща опция за по-добра релевантност.)
- [x] `servicenow_table_logic` — пълната картина за една таблица: всички business rules (подредени по when+order), client scripts, UI policies, UI actions, ACL-и. Това е инструментът-вход за „разбери какво се случва при insert/update на incident“.

### Самодокументация (package `docs`)

- [x] Конвенция: env `SN_DOCS_DIR` (default `docs/instance/`); `index.md` като оглавление (автоматично регенерирано) + файл per област (`tables/incident.md`, ...). Tool description-ите инструктират модела: **първо чети docs, после питай инстанцията**.
- [x] `servicenow_docs_list` / `servicenow_docs_read` / `servicenow_docs_search` (grep по съдържание) — read слой; евтини, read-only; защита срещу path traversal.
- [x] `servicenow_docs_write` — създава/обновява MD файл (+ автоматично обновява `index.md`); само `.md`, само в директорията.
- [x] **Mermaid генератори** (детерминистични):
  - `servicenow_generate_er_diagram` — по списък от таблици чете `sys_dictionary` references и строи `erDiagram`;
  - `servicenow_generate_table_flow` — от business rules на таблица (when/order) строи `flowchart` на жизнения цикъл.
- [x] MCP resource `servicenow://docs/{path}` — декларативно закачане на документацията.
- [x] Prompt шаблон `servicenow_document_table` — оркестрира: schema + table_logic + диаграми → пише `tables/{name}.md`.

---

## Ред на изпълнение и принципи

1. Фаза 0 → 1 → 2 са строго последователни (всяка стъпва на предишната). Фаза 3 пакетите са независими един от друг — могат по приоритет: Catalog → Change → Knowledge → CMDB (или по твоя нужда). Фаза 4 по всяко време след Фаза 1. Фаза 5 зависи само от Фаза 1 + schema tools от Фаза 2 — може да се изтегли напред, ако script-четенето и документацията са приоритет.
2. Всеки нов tool влиза с: zod схема с `.describe()` на всяко поле, annotations, package таг, unit тест на mapping-а, ред в README.
3. Очакван краен резултат: ~45–50 tool-а в ~12 пакета, default профил `core` с ~12 — балансът между „всичко възможно“ и използваем LLM контекст. `scripts` и `docs` пакетите са read-only/локални и са добри кандидати за default профила.

**Обща оценка: ~8–10 работни дни** за пълния план; след Фаза 2 (≈3½ дни) сървърът вече покрива всички core API-та.

---

# Фаза 6 — Харнес 2.0: дълбок анализ и план за подобрение

Дата на анализа: 2026-06-11 · Обхват: целият `src/` (24 файла, ~3500 реда), тестове, CI, конфигурация.
Това е **самодостатъчна спецификация за изпълнение от Opus 4.8** — всяка задача казва кой файл, какво и защо, с критерий за готовност.

> Под „харнес" разбираме споделената инфраструктура, върху която стъпват всички tools: `http.ts`, `auth.ts`, `host.ts`, `policy.ts`, `config.ts`, `settings.ts`, `errors.ts`, `logging.ts`, `result.ts`, `registry.ts`, `resources.ts`, `tools/util.ts`.
>
> **Допълнение 2026-06-12:** дълбокото ревю в [TODO.md](TODO.md) (задачи `S-*`/`A-*`/`Q-*`) се изпълнява заедно с тази фаза — `S-7` върви с К-1, `S-6` с К-4, `A-4` с М-1, `Q-1`/`Q-3` преди стъпка 2 (предпазна мрежа), `A-2` преди Фаза 7, `A-1` с MI-2.

## 6.0 Констатации от анализа (състояние към днес)

**Проверено на живо:** `npm run build` ✅ · `eslint .` ✅ · 50/50 unit теста ✅ (с Node 22; виж К-8 за Node 12 капана). 40 регистрирани tool-а в 12 пакета.

> **Одит 2026-06-12 (след ревю-имплементацията):** 107/107 теста · 46 tools в 13 пакета · git хранилище с commit-по-задача · SDK **1.29** (Х-1 ✅) · prompts.ts съществува (Х-3 ✅) · README tools таблицата се генерира (М-5 ✅ по същество, виж бележката) · type-checked ESLint · ConfigStore. Слабостите „SDK изостанал“, „не е git хранилище“ и „дублирана истина в README“ от списъка по-долу са вече решени.

**Силни страни (да се запазят при рефакторинг):**

- Един общ `snRequest()` с retry/backoff, Retry-After, timeout, SSRF guard, чисто разделение transport-/API-грешки.
- Policy слоят (`assertTableAllowed`/`assertWriteAllowed`) се прилага последователно в **api/** слоя (не в tools/) — проверих table, attachment, cmdb, importset, batch: всички минават през него. Batch дори извлича таблицата от под-URL-и.
- Дисциплина: всеки tool има annotations, zod `.describe()` на всяко поле, structured error payload; stdout е свещен (логове само на stderr).
- `config.ts` пише .env атомарно (tmp+rename) и пази чужди ключове/коментари; `formatEnvValue` е издържан срещу dotenv round-trip капаните.

**Слабости (адресирани в задачите по-долу):** дублиран ~25-редов boilerplate във всеки от 40-те tool-а; принадлежността tool→package живее само в `registry.ts` (разделена от дефинициите); SDK е изостанал (1.12 → 1.29); OAuth токен не се инвалидира при 401; `fetchAll` пагинира без стабилна подредба; няма схема-кеш (всяко `describe_table` бие инстанцията); pretty-print JSON хаби ~2× токени; **проектът не е git хранилище**.

## 6.1 Предпоставки (преди всякакъв рефакторинг)

- [x] **П-1 · Git init.** _(готово 2026-06-12, commit `2424fcf` — baseline + commit-по-задача дисциплина оттогава)_ `.gitignore` покрива `node_modules/`, `build/`, `.env`.
- [x] **П-2 · Node 20+ защита.** _(готово, commit `2a84eb3`)_ Реален инцидент: при system Node 12 `npm run build` гърми с неясни грешки, а `node --test` изобщо не тръгва. Действия: (а) `package.json` → `"engines": { "node": ">=20" }`; (б) `.npmrc` с `engine-strict=true`; (в) ранна проверка в `src/index.ts` преди какъвто и да е import-зависим код: ако `process.versions.node` major < 20 → ясно съобщение на stderr + `process.exit(1)`.
      _Критерий:_ под Node 12 `node build/index.js` отпечатва човешко обяснение вместо SyntaxError.

## 6.2 Коректност и устойчивост на харнеса (малки, високостойностни поправки)

- [x] **К-1 · OAuth: инвалидация при 401.** _(готово, commit `b48a4f1`)_ `auth.ts` кешира токена до изтичане (`tokenCache`), но ако токенът бъде отнет сървърно, всички заявки връщат 401 до края на TTL-а. В `http.ts`: при отговор 401 и `getAuthMode() === "oauth"` → изтрий кеширания токен (нов експорт `invalidateToken(host)` от `auth.ts`) и повтори заявката **еднократно** с нов токен; второ 401 се връща като грешка. _Тест:_ mock fetch: 401 → token endpoint → 200; асерция, че токенът е поискан повторно.
- [x] **К-2 · Authorization да се изчислява per attempt.** _(готово, commit `b48a4f1`)_ В `snRequest()` `authorize(host)` се вика веднъж преди retry цикъла ([http.ts:116](src/http.ts#L116)); при дълъг backoff (до 8 s × N опита) OAuth токен може да изтече между опитите. Премести извикването вътре в `for` цикъла (Basic е евтин — само base64; OAuth така или иначе чете от кеш).
- [x] **К-3 · Стабилна пагинация при `fetchAll`.** _(готово, commit `61cbd26`)_ `queryTable` ([servicenow.ts:74-90](src/servicenow.ts#L74-L90)) пагинира с offset; без `ORDERBY` ServiceNow не гарантира подредба → при паралелни писания страниците могат да изпуснат/дублират редове. Ако `opts.query` не съдържа `ORDERBY` (case-sensitive проверка по подстринг е достатъчна) → добави `^ORDERBYsys_created_on` (или `ORDERBYsys_id`). _Тест:_ заявка без ORDERBY получава суфикса; заявка с ORDERBY остава непроменена.
- [x] **К-4 · Batch: ограничи под-URL-ите до `/api/`.** _(готово, commit `b10a50c`)_ `runBatch` ([api/batch.ts:96-100](src/api/batch.ts#L96-L100)) изисква само водеща `/` — под-заявка може да уцели `/oauth_token.do`, `/login.do` и пр. (същият хост, но извън REST повърхността и извън policy моделa). Изисквай `url.startsWith("/api/")`, с ясна грешка. _Тест:_ под-заявка към `/login.do` → грешка преди мрежово извикване.
- [x] **К-5 · `searchCode`: неутрализирай `^` в текста.** _(готово, commit `ff3e826`)_ Търсеният текст влиза суров в encoded query ([api/scripts.ts:241-243](src/api/scripts.ts#L241-L243)); `^` в текста се чете като разделител на условия и чупи/изкривява филтъра (read-only, но дава грешни резултати). ServiceNow няма escape за `^` в LIKE → при наличие на `^` в `text` върни ясна грешка „searchCode не поддържа '^' в търсения текст". Същото важи за `name`/`table` филтрите в `listScripts`.
- [x] **К-6 · `set_credentials` да валидира хоста при запис.** _(готово, commit `d0e2822`)_ Сега невалиден `instance` се открива чак при първата заявка. В handler-а на `servicenow_set_credentials` ([tools/admin.ts:40-58](src/tools/admin.ts#L40-L58)): преди `saveCredentials` извикай `resolveHost(args.instance)` в try/catch → невалиден/забранен хост се отхвърля с грешката на `resolveHost`, нищо не се записва. (Решението „смяната на instance не е проблем" остава в сила — това е валидация на формат/SSRF, не ограничение на домейна.)
- [x] **К-7 · Resources да уважават пакетите.** _(готово, commit `07006b5`)_ `registerResources` ([resources.ts](src/resources.ts)) регистрира `servicenow://tables` и `servicenow://schema/{table}` безусловно, дори когато пакет `schema` е изключен. Подай enabled set-а (или извикай `resolveEnabledPackages` вътре) и регистрирай тези два resource-а само при активен `schema`; `servicenow://status` остава винаги.
- [x] **К-8 · CI: Node матрица + coverage.** _(готово, commit `5002c2d`)_ `.github/workflows/ci.yml` тества само една версия. Добави `strategy.matrix.node: [20, 22, 24]`; добави стъпка `npx c8 --reporter=text node --test test/*.test.js` (праг не е нужен първоначално — само видимост). `npm test` дублира build-а (`npm run build && node --test`), а CI вече прави `npm run build` — раздели на `test` (само `node --test`) и `test:full` ако е нужно.

## 6.3 Модулизация — отделни модули за лесна поддръжка

Целта: ясни слоеве с еднопосочни зависимости, дефиниции на tools като **данни** вместо код, и генерируема документация.

### 6.3.1 Целева структура на директориите

```
src/
├── index.ts                  # bootstrap: env, version guard, server, transport, shutdown
├── core/                     # ниво 0 — без зависимости към MCP SDK
│   ├── errors.ts             # ServiceNowError (както е)
│   ├── logging.ts            # stderr JSON logger (както е)
│   ├── settings.ts           # env настройки (както е)
│   ├── config.ts             # credentials + .env запис (както е)
│   ├── policy.ts             # allow/deny/readonly (както е)
│   ├── host.ts               # resolveHost/SSRF (както е)
│   ├── auth.ts               # Basic/OAuth + invalidateToken (К-1)
│   └── http.ts               # snRequest (К-1/К-2 промени)
├── api/                      # ниво 1 — чисти ServiceNow клиенти; внасят само core/
│   ├── table.ts              # ← преместеният src/servicenow.ts (вкл. К-3)
│   ├── aggregate.ts … scripts.ts  # както са, с поправени import пътища
│   └── plugin.ts
├── mcp/                      # ниво 2 — всичко, което знае за MCP SDK
│   ├── registry.ts           # пакети/профили + регистрация от манифеста
│   ├── define.ts             # defineTool() + типът ToolSpec (нов, виж 6.3.2)
│   ├── result.ts             # ok/fail/okQueryResult (както е)
│   ├── resources.ts          # с К-7
│   └── prompts.ts            # нов (Х-3)
└── tools/                    # ниво 3 — само декларации ToolSpec[]
    ├── table.ts … scripts.ts # пренаписани като данни (6.3.2)
    └── admin.ts
```

Правила за зависимости (проверими): `core` не внася от никого; `api` внася само `core`; `mcp` внася `core` (не `api`, освен `resources.ts` → `api/meta`); `tools` внася `api` + `mcp/define` + `mcp/result`. `src/servicenow.ts` остава като **re-export shim** (`export * from "./api/table.js"`) докато тестовете се мигрират, после се трие.

- [x] **М-1 · Премести файловете** _(готово, commit `5e6cd04`)_ по схемата (чист move + поправка на import-и, нула промяна в поведение). Тестовете внасят от `build/` — провери кои пътища ползват (`test/*.js` → `build/servicenow.js` и пр.) и или запази shim-ове, или обнови тестовете в същия commit. _Критерий:_ build/lint/50 теста зелени; `git diff --stat` показва основно renames.
- [x] **М-2 · ESLint граници.** _(готово, commit `ab6c252`)_ Добави `eslint-plugin-import` (или ръчно `no-restricted-imports` per директория чрез flat-config overrides): `src/core/**` не може да внася от `api|mcp|tools`; `src/api/**` не може от `mcp|tools`; `src/tools/**` не може от `core/http` директно (само през `api/`). _Критерий:_ нарочно грешен import гърми на lint.

### 6.3.2 Декларативен tool манифест (най-голямата печалба за поддръжката)

Днес всеки tool е ~25 реда `server.registerTool(...)` + ръчен `runTool` wrapper, а package принадлежността е в отделен файл (`registry.ts: TOOL_GROUPS`). При 40 tool-а това са ~1000 реда механичен код и две места, които трябва да се поддържат синхронни.

- [x] **М-3 · `mcp/define.ts`.** _(готово, commit `71b6058`)_ Типът и помощникът:

  ```ts
  export interface ToolSpec<S extends z.ZodRawShape> {
    name: string; // "servicenow_query_table"
    title: string;
    description: string;
    package: string; // "table" — единственото място за package таг
    annotations: ToolAnnotations;
    input: S; // zod shape, както досега
    /** Полета за лога; не слагай тайни/encoded queries. */
    logFields?: (
      args: z.objectOutputType<S, z.ZodTypeAny>,
    ) => Record<string, unknown>;
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>;
  }
  export function defineTool<S extends z.ZodRawShape>(
    spec: ToolSpec<S>,
  ): AnyToolSpec;
  ```

  Регистрацията (в `mcp/registry.ts`) обхожда манифеста и сама увива handler-а в `runTool(name, logFields?.(args) ?? {}, …)` — `tools/util.ts` се поглъща тук. Всеки `tools/*.ts` вече експортира `const specs: AnyToolSpec[]` вместо `registerXxxTools(server)`.

- [x] **М-4 · Мигрирай 40-те tool-а към ToolSpec** _(готово, commit `71b6058`)_ пакет по пакет (table → admin → останалите), след всеки пакет: build+test. `TOOL_GROUPS` в registry.ts се заменя с `ALL_TOOLS: AnyToolSpec[]` (конкатенация на манифестите); `ALL_PACKAGES` се извежда от `new Set(ALL_TOOLS.map(t => t.package))`. Профилите (`core`, `all`) и `resolveEnabledPackages` остават както са. _Критерий:_ `servicenow_get_status` връща същия `enabledPackages`; имената/схемите на tools са байт-идентични (snapshot тест: списък от `{name, package, annotations}` срещу фикстура).
- [x] **М-5 · Генерирана README таблица.** _(готово по същество 2026-06-12, commit `5bd5489` — `scripts/readme-tools.mjs` + `npm run docs:readme` върху `describeAllTools()`; пазачът е `test/readme-sync.test.js` вместо CI diff стъпка)_ След М-4 генераторът се опростява да чете `ALL_TOOLS` директно. **Остатък:** env таблицата в README е още ръчна — генерирай и нея, когато настройките получат декларативен регистър.
- [x] **М-6 · Snapshot тест на манифеста.** _(готово, commit `ae7d123`)_ Тест, който материализира `{name, package, title, annotations}` за всички tools и го сравнява с чекирана JSON фикстура — всяка промяна по повърхността става видим diff в ревю.

## 6.4 Нови възможности на харнеса

- [x] **Х-1 · SDK ъпгрейд `@modelcontextprotocol/sdk` 1.12 → 1.29 (текуща).** _(констатирано готово при одита 2026-06-12 — node_modules вече е 1.29.0, InMemoryTransport се ползва от smoke тестовете)_ Носи: elicitation, structured tool output (`outputSchema`/`structuredContent`), MCP `logging` capability, протокол 2025-06-18. Стъпки: bump + `npm i`, build, прегледай breaking changes в changelog-а на SDK-то (registerTool API-то е стабилно от 1.12 — очаквай малки типови разлики), тестове. Това е **предпоставка за Х-2, Х-4, Х-5**.
- [x] **Х-2 · Elicitation за `set_credentials`** _(готово, commit `f15bb5d`)_ — затваря отворения trust-boundary елемент от TODO.md. След Х-1: в handler-а извикай `server.server.elicitInput()` с резюме на промяната („смяна на instance: X → Y, user: Z") и записвай само при потвърждение; ако клиентът не поддържа elicitation (capability check) → текущото поведение (запис без потвърждение) остава, за да не се чупи. _Тест:_ mock на elicit отговор decline → нищо не е записано.
- [x] **Х-3 · Prompts модул** _(констатирано готово при одита 2026-06-12 — `src/prompts.ts` с трите шаблона е реализиран с Фаза 4/5, виж DONE.md)_
- [x] **Х-4 · MCP logging capability** _(готово, commit `f15bb5d`)_ (отворен елемент от TODO.md). След Х-1: при activе client logging capability, `logger` праща и `server.sendLoggingMessage({ level, data })` освен stderr реда. Едно място за промяна: `emit()` в [logging.ts](src/logging.ts) получава опционален sink, който `index.ts` закача след `connect()`.
- [x] **Х-5 · `outputSchema` за ключови tools** _(готово, commit `f15bb5d`)_ Отклонение: приложено на get_status/test_connection (стабилни схеми); query_table/get_record/aggregate нарочно не — динамични payload-и и дублирането на structuredContent противоречи на О-2. (след Х-1, опционално разширение на М-3: поле `output?: z.ZodTypeAny` в ToolSpec). Започни само с `query_table`, `get_record`, `aggregate`, `get_status` — там структурата е стабилна и клиентите печелят най-много.
- [x] **Х-6 · `servicenow_test_connection`.** _(готово, commit `373688b`)_ `get_status` показва конфигурацията, но не казва дали тя **работи**. Нов admin tool: `GET /api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id` → връща `{ ok, status, latencyMs, user }`; 401/403 се връщат структурирано (не като exception), за да може моделът да реагира. Регистриран винаги (admin група).
- [x] **Х-7 · Email пакет** _(готово, commit `5f95db9`)_ — недовършеният елемент от Фаза 2: `servicenow_send_email` (POST `/api/now/email`, destructive=false, idempotent=false), `servicenow_get_email` (GET по sys_id). Зад package `email`, извън всички профили освен `all`. С `pluginCall` обвивка (Email API изисква активиран plugin на някои инстанции).
- [ ] **Х-8 · Транспортен избор (опционално).** `SN_TRANSPORT=stdio|http` в `index.ts`: при `http` ползвай `StreamableHTTPServerTransport` (порт от `SN_PORT`, default 3000). Чист modular switch — нищо друго не се променя, защото целият код вече е транспорт-агностичен. Прави сървъра ползваем отдалечено/в контейнер. (Защитата на HTTP endpoint-а — auth header/origin check — документирай като отговорност на оператора.)

## 6.5 Оптимизации (токени, латентност, натоварване на инстанцията)

- [x] **О-1 · `sysparm_exclude_reference_link=true` по подразбиране.** _(готово, commit `05b0341`)_ Table API връща reference полета като `{ value, link }` — `link` URL-ите са чист токен-баласт за LLM. В `queryPage`/`getRecord` ([api/table.ts]) добави параметъра по подразбиране, с opt-out `SN_INCLUDE_REF_LINKS=true` за редкия случай, в който link-овете трябват. Очакван ефект: −20–40% от размера на отговор с reference полета.
- [x] **О-2 · Компактен JSON изход.** _(готово, commit `05b0341`)_ `ok()`/`okQueryResult()` ([result.ts](src/result.ts)) ползват `JSON.stringify(_, null, 2)` — отстъпите грубо удвояват токените при големи резултати. Env `SN_RESULT_PRETTY` (default **false** → компактен изход; `true` за четим). Едно място за промяна: `asText()` + двете stringify в `okQueryResult`/`fail`. _Внимание:_ има тестове, които парсват изхода — те ползват `JSON.parse`, така че не зависят от форматирането; провери с пълния suite.
- [x] **О-3 · Схема-кеш с TTL.** _(готово, commit `103ab7f`)_ `describe_table`/`list_tables`/`get_cmdb_meta` връщат почти статични данни, а се викат често (и от resources). Малък generic `core/cache.ts`: `cached(key, ttlMs, fn)` върху `Map` с timestamp; TTL от `SN_SCHEMA_CACHE_TTL_SEC` (default 300, `0` изключва). Ключ: `host|table`. Прилага се само в `api/meta.ts` и `api/cmdb.ts#getCmdbMeta` — не генерализирай преждевременно към други четения.
- [x] **О-4 · Лимит на паралелизма (лек).** _(готово, commit `84ccbb5`)_ `tableLogic` пуска 5 паралелни заявки, `fetchAll` може да направи десетки последователни — добави прост семафор в `core/http.ts` (env `SN_MAX_CONCURRENT`, default 4) около `fetch`. Пази инстанцията от салви и прави 429 по-малко вероятен. ~15 реда код, без външна зависимост.
- [x] **О-5 · Телеметрия в процеса.** _(готово, commit `84ccbb5`)_ Брояч в `core/http.ts`: `{ requests, errors: {401: n, 403: n, 429: n, …}, retries, totalMs }`; експонирай го в `servicenow_get_status` и в `servicenow://status`. Нула външни зависимости; прави „защо е бавно/чупи се" диагностицируемо от самия клиент.

## 6.6 Ред на изпълнение за Opus 4.8

| Стъпка | Задачи                   | Защо в този ред                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------- |
| 0      | П-1, П-2                 | Безопасност на рефакторинга; реален Node 12 инцидент             |
| 1      | К-1 … К-8                | Малки, независими, всяка с тест; вдигат качеството преди местене |
| 2      | М-1, М-2                 | Чисто преместване докато диффът е малък                          |
| 3      | М-3 → М-4 → М-5 → М-6    | Манифестът; пакет по пакет, винаги зелено                        |
| 4      | Х-1 → Х-2/Х-4/Х-5        | SDK ъпгрейдът отключва трите                                     |
| 5      | Х-3, Х-6, Х-7, О-1 … О-5 | Независими; по приоритет на потребителя                          |
| 6      | Х-8 (опц.)               | Само при нужда от отдалечен достъп                               |

Работни правила (важат за всяка стъпка):

1. **Винаги зелено:** след всяка задача `npm run build && npm run lint && node --test test/*.test.js` (Node ≥ 20!) — 50+ теста, без изключени.
2. **Една задача = един commit** с ID-то ѝ в заглавието (напр. `К-3: stable ordering for fetchAll`).
3. Нова env променлива → ред в README env референцията + `.env.example`; нов tool → през манифеста (М-3), никога direct `registerTool`.
4. Поведенчески промени по подразбиране (О-1, О-2) се отбелязват в README секция „Defaults".
5. Решенията „won't-fix" от TODO.md (права на `.env`, смяна на instance) **остават в сила** — К-6 валидира формат/SSRF, без да ограничава домейна.
6. **Ревюто от 2026-06-12** (TODO.md, задачи `S-*`/`A-*`/`Q-*`) е **изцяло имплементирано** (виж DONE.md) — вкл. A-1 per-package policy, A-2 ConfigStore (`config.ts`: атомарен snapshot + `reloadCredentialsFromEnv()`), A-8 генерираната README tools секция (`npm run docs:readme` + sync тест). М-1/М-2 местят готовите модули; М-5 за tools таблицата е на практика готов — остава само env таблицата.
7. **(Q-6) Тест дисциплина:** всяка поведенческа промяна влиза с тест в същия commit. Пазачи: README sync тестът, контрактният snapshot на core профила (mcp-smoke) и винаги зеленият пълен suite — и трите падат при недисциплинирана промяна.

**Оценка на обема:** Стъпки 0–2 ≈ 1 ден; стъпка 3 ≈ 1 ден; стъпка 4 ≈ ½–1 ден; стъпка 5 ≈ 1 ден. Общо **~3½–4 работни дни** за пълната Фаза 6.

---

# Фаза 7 — Мулти-инстанс: профили, метаданни, анализ

Дата: 2026-06-11 · Изискване от потребителя: „казвам му към коя инстанция да се пойнтне, да се логне, да си свали метаданни, да си направи анализ — искам да може да работи с много инстанции."

**Зависимост:** изисква завършен tool манифест от Фаза 6 (М-3/М-4) — иначе параметърът `instance` трябва да се нишка ръчно през 40 tool-а. Стъпва и на О-3 (схема-кешът вече е ключуван по host) и Фаза 5 docs конвенцията.

## 7.1 Модел на конфигурацията: именувани профили

Принцип: **пълна обратна съвместимост** — днешните `SN_INSTANCE`/`SN_USER`/`SN_PASSWORD` стават профил с име `default`; нищо не се чупи за съществуващи потребители.

- [ ] **MI-1 · Профили в `.env`.** Конвенция: `SN_PROFILE_<NAME>_INSTANCE` / `_USER` / `_PASSWORD` (+ опционално `_AUTH`, `_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET`, `_OAUTH_GRANT`, `_READONLY`, `_TABLES_ALLOW`, `_TABLES_DENY`). `<NAME>` е `[A-Z0-9_]+` (в tools се подава lowercase, напр. `dev`, `test`, `prod`). В `core/config.ts`: `listProfiles(): string[]` (сканира `process.env` по префикса + `default` ако старите ключове са налични), `getCredentials(profile = activeProfile())`. Активният профил: `SN_ACTIVE_PROFILE` (персистира се в `.env` при смяна; default `default`).
  _Критерий:_ стар `.env` без профили работи непроменено; тест за паралелни профили + precedence.
- [ ] **MI-2 · Per-profile policy.** `policy.ts`: `isReadOnly(profile)` / allow/deny четат първо `SN_PROFILE_<NAME>_READONLY` и пр., после глобалния ключ като fallback. Това позволява реалния сценарий: **prod = read-only, dev = пълни права** в един и същи сървър. `resolveHost` остава общ (SSRF guard важи за всички профили).
- [ ] **MI-3 · Контекст на заявката чрез `AsyncLocalStorage`.** Вместо да се променя сигнатурата на всички 20+ функции в `api/`, профилът тече имплицитно: `core/context.ts` с `AsyncLocalStorage<{ profile: string }>`; `defineTool` (М-3) автоматично добавя **опционален** input параметър `instance` към всеки tool (`describe: "Име на инстанс-профил; по подразбиране активният."`) и изпълнява handler-а в `als.run({ profile }, …)`. `http.ts`/`auth.ts`/`policy.ts` четат профила от ALS с fallback към активния. OAuth `tokenCache` вече е ключуван по host → работи без промяна.
  _Критерий:_ `servicenow_query_table` с `instance: "test"` удря host-а на `test` профила (mock-fetch тест с два профила); без параметър — активния.
- [ ] **MI-4 · Admin tools за профили.** (а) `servicenow_list_instances` — име, host, auth mode, readOnly, hasCredentials за всеки профил (**никога пароли**); (б) `servicenow_use_instance(name)` — сменя `SN_ACTIVE_PROFILE` и го персистира; (в) `servicenow_set_credentials` получава опционален `profile` (default — активния) и пише префиксираните ключове; валидацията К-6 важи. (г) `servicenow_get_status` и `servicenow://status` показват активния профил + списъка.
- [ ] **MI-5 · Кеш и телеметрия per host.** Провери, че О-3 ключът (`host|table`) и О-5 броячите са коректни при много инстанции — телеметрията се разбива по профил (`{ profile: { requests, errors… } }`).

## 7.2 Метаданни: снапшот и анализ на инстанция

Целта на „да си свали метаданните и да си направи анализ": еднократно (или периодично) сваляне на структурната картина на инстанцията в локални файлове, които после служат за контекст и за сравнение между инстанции.

- [ ] **MI-6 · `servicenow_snapshot_instance`.** Тегли и записва в `docs/instance/<profile>/` (конвенцията от Фаза 5; `SN_DOCS_DIR` root):
  - `tables.md` + `tables.json` — sys_db_object (име, label, extends, брой записи по избор чрез Aggregate);
  - `schema/<table>.md` — sys_dictionary за подадените или top-N таблици (args: `tables?: string[]`);
  - `plugins.md` — активни plugins (`v_plugin`, fallback `sys_plugins`);
  - `apps.md` — инсталирани приложения (`sys_app`, `sys_store_app`);
  - `automation.md` — статистика на скриптовете по тип (Aggregate върху script таблиците: брой, активни, последна промяна);
  - `index.md` — оглавление + дата на снапшота.
    Всичко през съществуващите api/ слоеве (meta, aggregate, scripts) — нула нови HTTP клиенти. Markdown за хора/LLM + JSON за машинно сравнение. _Критерий:_ mock-fetch тест генерира снапшот в temp dir; идемпотентен повторен запуск презаписва чисто.
- [ ] **MI-7 · `servicenow_compare_instances(a, b)`** — флагманът на фазата. Сравнява два профила (на живо или от JSON снапшотите, ако са налични — арг. `from_snapshot?: boolean`):
  - таблици само в едната;
  - колони с различен тип/задължителност/reference (sys_dictionary diff по таблица);
  - скриптове (по тип+име): само в едната / различен source (SHA-256 на скрипта, не диф на текста — компактно);
  - plugin/app разлики.
    Изход: MD отчет (`docs/instance/_compare/<a>-vs-<b>.md`) + структурирано резюме в tool резултата. Това отговаря на „dev → test → prod: какво се разминава?".
- [ ] **MI-8 · Resources per профил.** `servicenow://instances` (списък), `servicenow://{profile}/schema/{table}` като нов template; старите URI-та остават за активния профил.

**Оценка:** ~2 дни (MI-1…MI-5 ≈ 1 ден; MI-6…MI-8 ≈ 1 ден).

---

# Фаза 8 — Логически тестове на флоуове + проверка на код

Дата: 2026-06-11 · Изискване: „да може да прави логически тестове на различни флоуове и да може да проверява кода."

Три допълващи се нива — статичен поглед (какво **би** се изпълнило), доказателства (какво **се е** изпълнило) и истински тестове (ATF). Стъпва на `scripts` пакета (готов) и Фаза 5 schema tools.

## 8.1 Flow intelligence (package `flows`, read-only)

- [ ] **FT-1 · `servicenow_list_flows` / `servicenow_get_flow`.** Flow Designer живее в `sys_hub_flow` (+ `sys_hub_trigger_instance`, `sys_hub_action_instance`, `sys_hub_flow_logic`). `list_flows`: филтър по таблица/активност/тип trigger — метаданни без дефиницията. `get_flow`: парсира JSON дефиницията до **структуриран изглед**: trigger (таблица, условие, кога), подредени стъпки (действие, входове, условия на branch-овете), подфлоута. Целта не е пълна декомпилация — а достатъчно, за да може LLM да разсъждава върху логиката. Legacy workflows (`wf_workflow`/`wf_activity`) — същия чифт tools с `kind: "workflow"`.
- [ ] **FT-2 · `servicenow_trace_table_event(table, operation)` — детерминистична симулация.** За дадена таблица + операция (insert/update/delete/query) строи **подредената верига** на това, което ServiceNow би изпълнил: display → before BR-и (по order) → engines → after BR-и → async BR-и + flows/workflows с trigger върху таблицата + notifications (`sysevent_email_action`) + event-и (`sysevent_script_action`). Връща списък с условията на всеки елемент + опционален Mermaid `flowchart` (свързва се с Mermaid генераторите от Фаза 5). Това е „логическият тест без изпълнение": отговаря на „ако създам incident с priority=1, какво ще се случи и в какъв ред?" — LLM-ът оценява условията срещу хипотетичния запис.
- [ ] **FT-3 · `servicenow_get_flow_runs` — доказателства за изпълнение.** Чете `sys_flow_context` (+ `sys_flow_log` при нужда): по flow или по запис (document_id) — кога е тръгнал, статус (success/error/waiting), грешка. Затваря цикъла: „флоуто, което трябваше да тръгне (FT-2), тръгна ли наистина?" Аналогично за BR грешки: `syslog` четене с филтър по source/време е достъпно през съществуващия `query_table` — добави prompt подсказка, не нов tool.

## 8.2 Истински тестове: ATF (package `atf`, изисква plugin + роли)

- [ ] **FT-4 · ATF изпълнение през CI/CD API** (`pluginCall` обвивка): `servicenow_list_atf_tests` / `servicenow_list_atf_suites` (Table API: `sys_atf_test`, `sys_atf_test_suite`); `servicenow_run_atf_test(test_sys_id)` и `servicenow_run_atf_suite(suite_sys_id)` → POST `/api/sn_cicd/testsuite/run` (resp. `/api/sn_cicd/atf/test/run`... провери точните пътища в CI/CD API спецификацията при имплементация) — връща `execution_id`; `servicenow_get_atf_result(execution_id)` — progress (`/api/sn_cicd/progress/{id}`) + резултати от `sys_atf_test_result`. Annotations: run-tool-овете са `readOnlyHint: false` (изпълняват код на инстанцията!), `destructiveHint: false`. **Не** в default профила. _Това е официалният път за „логически тестове на флоуове" върху жива инстанция_ — ATF тестът може да създаде запис, да провери стойности, да валидира UI policy и да се изчисти сам.

## 8.3 Проверка на код (package `codecheck`, изцяло локален анализ)

- [ ] **FT-5 · `servicenow_lint_script(type, sys_id)` + `servicenow_lint_table(table)`.** Тегли source през съществуващия `api/scripts.ts` слой и пуска **детерминистични правила** локално (нула мрежа извън fetch-а на кода). Начален rule set (всяко правило: id, severity, ред, снипет, подсказка):
  - `hardcoded-sys-id` — 32-hex литерал в кода;
  - `gr-unbounded-query` — `new GlideRecord(...)` + `.query()` без `addQuery`/`addEncodedQuery`/`setLimit` (full table scan);
  - `query-in-loop` — `.query()`/`getReference` вътре в `while`/`for` (N+1);
  - `current-update-in-br` — `current.update()` в before BR (двойно изпълнение) — изисква контекста `when` от метаданните, които вече имаме;
  - `set-workflow-false` — `setWorkflow(false)` (заобикаля BR-и — само предупреждение);
  - `eval-usage`, `gs-sleep`, `gs-log-deprecated` (gs.log → gs.info), `hardcoded-instance-url` (`https://….service-now.com` в код);
  - client: `gr-on-client` (GlideRecord в client script — бавно), `sync-get-reference` (`getReference` без callback).
    Имплементация: regex-базирани правила в чист TS (`api/codecheck.ts` — таблица от правила, лесно разширима); **без** нова runtime зависимост. Syntax проверка чрез `new Function(source)` в try/catch е евтин бонус за server-side ES5 — отбележи ограниченията (SN globals, scoped API) в описанието. `lint_table` = lint на всички активни BR/CS/UI policy скриптове на таблицата (през `tableLogic`).
- [ ] **FT-6 · `servicenow_code_health(scope?)`** — агрегиран отчет за инстанция или таблица: брой скриптове по тип, активни/неактивни, последно пипани, findings от FT-5 по severity, топ нарушители. Записва MD в `docs/instance/<profile>/code-health.md` (връзва се с MI-6 снапшота). Това е „провери кода" на едро — здравословна картина, от която LLM-ът предлага конкретни поправки.
- [ ] **FT-7 · Code Search ъпгрейд (опционално, отложен от Фаза 5).** Ако `/api/sn_codesearch/code_search/search` е наличен (probe с `pluginCall`) — `search_code` го ползва вместо LIKE итерацията; fallback остава. По-добра релевантност при големи инстанции.

## 8.4 Ред и оценка

| Стъпка | Задачи      | Бележка                                                              |
| ------ | ----------- | -------------------------------------------------------------------- |
| 1      | FT-2        | Най-висока стойност, нула нови API-та (стъпва на tableLogic)         |
| 2      | FT-1, FT-3  | Flow Designer четене + доказателства                                 |
| 3      | FT-5 → FT-6 | Lint правилата първо, отчетът върху тях                              |
| 4      | FT-4        | ATF — изисква PDI с активиран CI/CD plugin за ръчна проверка         |
| 5      | FT-7        | Опционално                                                           |

Правилата от 6.6 (винаги зелено, един commit на задача, README/env дисциплина, нови tools само през манифеста) важат изцяло. Новите пакети: `flows`, `atf`, `codecheck` — `flows` и `codecheck` са read-only и са кандидати за `core` профила; `atf` никога не влиза в default.

**Оценка:** ~2–3 дни (FT-2 ≈ ½ ден; FT-1/FT-3 ≈ ½–1 ден; FT-5/FT-6 ≈ 1 ден; FT-4 ≈ ½ ден).

---

## Опционално (без фаза, при заявка от потребителя)

- [ ] **Integration suite срещу жив PDI** — e2e тестове зад env гейт (`SN_E2E=1` + реални креденшъли), пускани ръчно/nightly, не в CI по подразбиране. (От архитектурното ревю 2026-06-11.)
- [ ] **Export API (CSV/XLSX)** — сваляне на таблични данни през content negotiation на Table API. (Останал кандидат от стария roadmap; Identify&Reconcile и Batch вече са покрити.)

## Обобщена пътна карта (Фази 6–8)

```
Фаза 6 (харнес 2.0, ~4 дни)
  └─ М-3/М-4 манифестът е критичният път
       ├─ Фаза 7 (мулти-инстанс, ~2 дни)   ← изисква манифеста
       │    └─ MI-6/MI-7 снапшот+сравнение ← ползва Фаза 5 docs конвенцията
       └─ Фаза 8 (флоу тестове + код, ~2–3 дни) ← независима от Фаза 7;
            FT-2/FT-5 могат да тръгнат веднага след Фаза 6 стъпка 3
```

Общо Фази 6–8: **~8–9 работни дни**. Недовършеното от старите фази (Email Х-7, Prompts Х-3, docs пакетът от Фаза 5) е включено в реда на Фаза 6 / реферирано от Фаза 7–8.
