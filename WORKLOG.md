# WORKLOG — Sincronia MCP

> Хронологичен дневник на всичко свършено по проекта. Най-новото е най-отгоре.
> Правило: след всяка задача се обновяват този файл + всички засегнати MD документи (IMPLEMENTATION-PLAN.md, TODO.md, DONE.md, README.md).

## 2026-06-12 — имплементация на ревю задачите

> Указание от Иван: worklog-ът да е **подробен** — за всяка задача: проблем, решение, файлове, тестове, commit.

### П-1 · git init + baseline (commit `2424fcf`)

- **Защо:** проектът не беше git хранилище — нямаше как да важи правилото „една задача = един commit“, нито имаше връщане назад при рефакторинг.
- **Какво:** `git init -b main`, локален git identity, baseline commit на цялото работещо състояние (28 tools, 59 теста зелени към момента на снимката). `.gitignore` вече покриваше `.env`, `node_modules/`, `build/` — не е пипан.
- **Файлове:** няма промени по кода — само нов `.git`.

### S-1 + S-2 · describe_table вижда наследените колони (commit `9d8da51`)

- **Проблем (критичен):** `describeTable` питаше `sys_dictionary` само с `name=<таблица>` — а в ServiceNow наследените полета живеят на родителя. За `incident` отговорът нямаше `short_description`, `priority`, `state`… (дефинирани на `task`) — LLM-ът би грешил при всеки create/update на разширена таблица. Освен това `listTables` четеше `super_class` като display value (label „Task“), безполезно за обхождане.
- **Решение:** нова `getTableChain(table)` в [api/meta.ts](src/api/meta.ts) — итеративно обхожда `sys_db_object.super_class.name` (dot-walk, raw values; guard: дълбочина ≤ 20 + проверка за цикли). `describeTable` пита с `nameIN<верига>^elementISNOTEMPTY`; при дублиран `element` печели най-близкият до детето (rank по позиция във веригата); нова колона `sourceTable` показва къде е дефинирано полето. `listTables` подава `fields: ["name","label","super_class.name"]` с `displayValue:"false"`.
- **Файлове:** `src/api/meta.ts` (пренаписан), `test/meta.test.js` (нов: верига, child override, непозната таблица, dot-walk), `test/helpers.js` (нов — общи `baselineEnv`/`withEnv`/`withFetch`/`jsonResponse`, началото на Q-2), `test/diagrams.test.js` (mock-ът вече обслужва и заявката към `sys_db_object`).
- **Тестове:** 63 зелени (4 нови); build + lint чисти. Открито попътно: междувременно в repo-то са се появили `api/diagrams.ts` + тестовете му (Фаза 5 Mermaid) — единственият им счупен mock е адаптиран.

### Q-3 · тестове за непокритите поведения на харнеса (commit `b6469f1`)

- **Проблем:** най-сложната логика в кодовата база нямаше нито един тест: `fetchAll` пагинацията, truncation цикълът в `okQueryResult`, retry матрицата (кое се повтаря и кое не), `pluginCall` 404 декорацията, env парсерите в settings.
- **Решение:** 5 нови тестови файла, 17 теста, всички върху mock fetch (нула мрежа): `fetchall.test.js` — пагинация през няколко страници, празна probe страница при точно деление, SN_MAX_RECORDS cap (вкл. че последната заявка иска само остатъка под капа), начален offset; `result.test.js` — passthrough под лимита, halving truncation с обяснителна бележка и спазен лимит, деградация до 0 записа; `http-retry.test.js` — transport грешка: GET се повтаря / POST не (резултатът от write е неизвестен), получен 502: retry за GET, мигновена грешка за POST, Retry-After като HTTP дата; `plugin.test.js` — 404 hint + 403 passthrough; `settings.test.js` — positiveInt контрактът (валидно/невалидно/нула/отрицателно/дробно) за четирите env-а.
- **Попътна корекция на очакване:** при offset и точно деление fetchAll прави още една probe заявка — тестът документира това поведение явно.
- **Файлове:** само `test/` — кодът не е пипан. **Тестове:** 80 зелени (от 63).

### Q-1 + Q-4 · in-memory MCP smoke тестове (commit `f13f316`)

- **Проблем:** MCP повърхността (zod схеми, snake_case→camelCase мапинг на аргументи, `ok()`/`fail()` пликове, package gating) нямаше нито един тест — разместени аргументи в tool handler не би се хванал от api/ unit тестовете.
- **Решение:** `test/mcp-smoke.test.js` — истински SDK `Client` + `McpServer` през `InMemoryTransport` (без мрежа, без stdio), mock fetch под него. 7 теста: (1) **контрактен snapshot** — core профилът излага точно 15 поименно изброени tools (промяна в контракта чупи теста нарочно; застъпва М-6 от плана); (2) `all` ⊇ core + gated пакетите; (3) callTool happy path — схема→мапинг→ok() плик с count/total/records; (4) невалиден вход (limit −2) → error **без** мрежово извикване; (5) SN 403 → структуриран fail() payload (status + snDetail); (6) gated tool не е викаем от core; (7) `servicenow://status` resource — конфигурация без парола.
- **Открито при писането:** SDK 1.29 връща „unknown tool“ като isError резултат, не като protocol изключение — тестът приема и двете форми.
- **Файлове:** само `test/mcp-smoke.test.js`. **Тестове:** 87 зелени (от 80). Попътно: установено, че SDK-то вече е 1.29 (Х-1 от плана е междувременно свършена) и има нови docs/diagrams/prompts модули — пакетът tools е вече 46.

### S-6 · batch policy покрива stats/import/cmdb (commit `6ad6821`)

- **Проблем:** `tableFromUrl` в [api/batch.ts](src/api/batch.ts) разпознаваше само `/api/now/table/...` — дени-ната таблица оставаше четима през batch със Stats/Import/CMDB URL (заобикаляне на allow/deny policy).
- **Решение:** regex-ът покрива `/api/now/[vN/](table|stats|import)/{t}` и `/api/now/[vN/]cmdb/instance/{class}`. Тест: 5 URL варианта срещу deny списък → 403 преди каквато и да е мрежа.
- **Файлове:** `src/api/batch.ts`, `test/batch.test.js`. **Тестове:** 88 зелени.

### S-3 + S-4 · attachment коректност (commit `385fd57`)

- **Проблем (S-3):** `Buffer.from(s, "base64")` никога не хвърля — try/catch-ът беше мъртъв код и невалиден вход тихо качваше повреден файл. **(S-4):** size guard-ът беше СЛЕД `arrayBuffer()` — 1 GB attachment се теглеше изцяло в паметта само за да бъде отказан.
- **Решение:** `decodeBase64Strict` (regex `^[A-Za-z0-9+/]*={0,2}$` + дължина % 4; whitespace се толерира като в MIME); `downloadAttachment` първо чете метаданните и отказва по `size_bytes` (оценка ×4/3) преди download — post-check остава за липсващ/стар size_bytes.
- **Файлове:** `src/api/attachment.ts`, нов `test/attachment.test.js` (5 невалидни форми → 0 fetch; декодиране с пренос на ред; голям файл → отказ само с meta заявка; малък файл → base64 round-trip). **Тестове:** 92 зелени.

### S-7 · OAuth кешът се чисти при смяна на креденшъли (commit `946ea2d`)

- **Проблем:** ключът на tokenCache е `host|client|grant|user` — паролата не участва, така че токен, получен със старата парола, оцеляваше ротацията ѝ.
- **Решение:** нов `invalidateTokens()` в [auth.ts](src/auth.ts) (без import цикъл config↔auth), викан от `servicenow_set_credentials` след `saveCredentials`. Преизползваем за К-1 (401 инвалидация) от Фаза 6. Тест в auth.test.js: кеширан токен → invalidate → нов токен при следващата заявка.

### S-5 + S-8 · бързи корекции (commits `5c31ec7`, `70a961d`)

- **S-5:** `servicenow_aggregate` без count/avg/min/max/sum вече връща `fail()` с ясно съобщение без мрежово извикване (стигаше до инстанцията за SN грешка). Smoke тест: 0 fetch обаждания.
- **S-8:** `search_code` логваше търсения текст (потенциално лични данни, в разрез с правилото на logging.ts) — сега `textLength` + `type`.
- **Тестове:** 93 зелени.

### A-1 · per-package policy (commit `90668d3`)

- **Проблем (ВИСОКО):** policy моделът беше таблично-центричен — `SN_TABLES_DENY=change_request` спира Table API пътя, но Change Management API (`sn_chg_rest`) продължава да чете/пише change-ове. Липсваше втора ос на контрол за plugin API-тата.
- **Решение:** два нови env-а: `SN_PACKAGES_DENY` (маха цял пакет независимо от `SN_TOOL_PACKAGES`) и `SN_PACKAGES_READONLY` (Proxy фасада в registry.ts регистрира само tools с `readOnlyHint: true` — write инструментите изобщо не съществуват за модела). Нов `effectivePackages()` — единственият източник за enabled/denied/readOnly, ползван от registry и status payload-а. Документация: README env таблицата + изрична бележка „table deny ≠ plugin deny“ в security секцията (минимумът от A-8); `.env.example` допълнен.
- **Файлове:** `src/settings.ts` (общ `parseNameList` + двата getter-а), `src/registry.ts`, `src/status.ts`, `README.md`, `.env.example`, тестове в `mcp-smoke` (deny маха целия пакет; readonly пази read tools, маха order_catalog_item) и `settings.test.js`. **Тестове:** 102 зелени.
- **Технически детайл:** `Parameters<McpServer["registerTool"]>` дава `never` (generic overload) — фасадата е типизирана с loose passthrough, без да пипа аргументите.

### Q-5 (остатък) · SN_LOG_LEVEL тестове (commit `be291e6`)

- 4 теста на логинг филтъра: default info (debug отпада), error заглушава, debug пуска всичко, непознато ниво → fallback info; проверка на JSON структурата (ts/level/message/fields). Капва се `console.error` — нула промени по кода.

### Реорганизация: готовото → DONE.md (указание на Иван)

- Всичко имплементирано от ревюто (19/22 находки) е преместено от TODO.md в [DONE.md](DONE.md) като компактно резюме с commit референции; TODO.md остава само с отворените **A-2** (ConfigStore — след М-1/М-2, преди MI-1), **A-8** (генерирано README — след манифеста) и **Q-6** (процедурно). Заглавният статус на DONE.md обновен: 102/102 теста, type-checked ESLint, git история.

### A-4 + A-5 · дедупликации (commits `da3f056`, `4028969`)

- **A-4:** проверката `if (!data || data.result == null) throw` съществуваше в 7 копия (servicenow.ts ×4, attachment.ts ×3). Нов [api/shared.ts](src/api/shared.ts) с `expectResult`/`expectResultArray` — едно място, едно съобщение; всяко ново API го преизползва.
- **A-5:** status payload-ът се строеше в admin tool-а И в resources.ts — вече разминати (resource-ът нямаше `enabledPackages`). Нов [src/status.ts](src/status.ts) `buildStatusPayload()` — единствен източник за двете повърхности; resource-ът сега показва и пакетите (асерция в smoke теста).

### A-6 · noUncheckedIndexedAccess (commit `021cfa4`)

- **Защо:** кодът постоянно индексира външни SnRecord-и и масиви — компилаторът мълчеше за `undefined`.
- **Какво:** включено в tsconfig; 6 файла поправени с истински guard-ове (не `!`): regex групи през locals (batch, config), `lines[i]` → `entries()` итерация (docs, scripts), descriptor lookup с `continue` (scripts), IP октети с default (host), `PROFILES.core` → константа `CORE_PROFILE` (registry). Нула поведенчески промени, 93 теста зелени.

### A-7 · type-checked ESLint + snString (commit `42e1d5f`)

- **Какво:** `recommendedTypeChecked` върху `src/` (projectService), изрично `@typescript-eslint/no-floating-promises: error` (забравен await в async handler гълта грешки безследно); unsafe-assignment/member-access изключени съзнателно (SN payload-ите са untyped JSON).
- **Находка на правилата:** `no-base-to-string` хвана реален капан — `String(unknown)` върху SN поле при `display_value=all` (обект `{value, display_value}`) дава `"[object Object]"`. Нов `snString()` в api/shared.ts (скалари → текст, обекти → `""`), приложен на 16 места в meta/scripts/diagrams. Останалото: `require-await` поправки (Basic authorize → `Promise.resolve`, admin handlers и status resource вече не са фалшиво async — `runTool` приема и синхронен fn), ненужни type assertions махнати, OAuth grant валидация без cast.

### Q-2 · единни тестови helpers (commit `edcd07b`)

- 6-те по-стари тестови файла (http, batch, phase3, scripts, diagrams, auth) дублираха env блока + `withFetch` + `jsonResponse` — мигрирани към `test/helpers.js` (~150 реда по-малко). Тестовете са готови за общ-процесен runner (vitest миграцията от плана) — env vече се пипа само през `baselineEnv`/`withEnv`.

### A-3 · capability кеш за plugin API-та (commit `3cd86cb`)

- **Дизайн решение:** 404 от plugin API значи две различни неща — липсващ namespace (plugin-ът не е активен: „does not represent any resource“) или липсващ запис на работещ API („No Record found“). Кешира се **само** namespace вариантът (5 мин TTL) — иначе валидно „записът го няма“ би заключило цялото API.
- **Какво:** при кеширан namespace 404 следващите извиквания отказват мигновено без HTTP; успех маркира „available“; `servicenow_get_status` и `servicenow://status` показват `pluginApis: {API: available|unavailable|unknown}`. 5 теста, вкл. че fn не се изпълнява при кеширан отказ и че record 404 продължава да стига до инстанцията.

### Авто-одобрение на повтарящите се команди (.claude/settings.json)

- По молба на Иван:`npm run build`, `npm run lint`, `node --test test/*`, `npx tsc --noEmit*`, `export PATH=…nvm…`, `git add *`, `git commit *` са в `permissions.allow` на проектните настройки — спират да искат потвърждение. Съзнателно НЕ са добавени: `git push`, `node -e`, широки wildcard-и (изпълнение на произволен код).

### Създаден WORKLOG.md + правило за документация

- Постоянно правило (записано и в паметта ми): след всяка задача се обновяват worklog-ът и всички засегнати MD документи (TODO/DONE/IMPLEMENTATION-PLAN/README).
- **Дълбоко код ревю (синиър дев / архитект / QA) — завършено.** Прегледани: всичките 24 файла в `src/`, 8-те тестови файла (50 теста), tsconfig/eslint/CI. Резултат: **22 находки** в TODO.md, секция „Дълбоко ревю 2026-06-12“ — 8 синиър (S-1…S-8), 8 архитектурни (A-1…A-8), 6 QA (Q-1…Q-6), с приоритети и препоръчан ред. Ключови: **S-1 (критично)** `describe_table` пропуска наследените колони (sys_dictionary се пита само за самата таблица, не за веригата super_class — за `incident` липсват полетата от `task`); **S-6** table policy не се прилага за не-Table под-заявки в batch (stats/import/cmdb); **A-1** policy моделът е таблично-центричен и plugin API-тата (change/catalog/knowledge) заобикалят allow/deny; **A-2** process.env като mutable хранилище за креденшъли — да стане ConfigStore преди Фаза 7; **Q-1** tools/ MCP слоят е изцяло без тестове; **Q-3** fetchAll пагинацията (най-сложният цикъл) — нула тестове. Кодът не е пипан — само анализ. Кръстосана препратка добавена в IMPLEMENTATION-PLAN.md (работно правило 6 на Фаза 6).

## 2026-06-11

- **Фаза 7 + Фаза 8 спецификации** добавени в IMPLEMENTATION-PLAN.md: мулти-инстанс профили (MI-1…MI-8: AsyncLocalStorage контекст, per-profile policy, снапшот на метаданни, сравнение между инстанции) и логически тестове на флоуове + проверка на код (FT-1…FT-7: trace_table_event, Flow Designer четене, ATF, локален lint). Обща пътна карта Фази 6–8 ≈ 8–9 дни.
- **Фаза 6 „Харнес 2.0“** — дълбок анализ на харнеса, документиран в IMPLEMENTATION-PLAN.md като спецификация за Opus 4.8: предпоставки (П-1 git init — проектът не е git repo!, П-2 Node ≥ 20 защита), коректност (К-1…К-8: OAuth 401 инвалидация, стабилна fetchAll пагинация, batch URL ограничение до /api/, и др.), модулизация (М-1…М-6: слоеве core/api/mcp/tools + декларативен tool манифест + генерирано README), нови възможности (Х-1…Х-8: SDK 1.12→1.29, elicitation, prompts, test_connection, email, HTTP транспорт), оптимизации (О-1…О-5: exclude_reference_link, компактен JSON, схема-кеш, семафор, телеметрия).
- **Сверка план ↔ код:** Фаза 5 script intelligence (4 tool-а) реално завършена — отметките в плана актуализирани.
- **Открит environment капан:** default shell Node е v12 → build/test гърмят неясно; работи се с `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`. Записано в паметта; трайната защита е П-2.
