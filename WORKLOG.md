# WORKLOG — Sincronia MCP

> Хронологичен дневник на всичко свършено по проекта. Най-новото е най-отгоре.
> Правило: след всяка задача се обновяват този файл + всички засегнати MD документи (IMPLEMENTATION-PLAN.md, TODO.md, DONE.md, README.md).

## 2026-06-12 (късно) — бек логът от тройния анализ е имплементиран (131 теста)

### Какво влезе (по един commit на задача; „почвай го“ от Иван)

- **S2-1 · strict zod схеми (`e879321`):** разровено в SDK 1.29 — `normalizeObjectSchema` приема и готови object схеми, не само raw shapes → registry подава `z.object(spec.input).strict()`. Typo аргумент (`tabel`) вече е валидационна грешка, не тиха заявка без филтър. Smoke тест: 0 fetch.
- **S2-2 · per-host семафор + телеметрия (`13a2810`):** всяка инстанция има собствен лимит на паралелизма и собствени броячи; `getTelemetry()` връща агрегат + `perHost` (в status, output схемата разширена). Готово за Фаза 7.
- **Q2-4+Q2-5 (`9ef092b`):** перф пазач — 10k записа през halving truncation < 2 s; elicitation **accept** пътят тестван (confirm=true → запис в temp SN_ENV_FILE). Поука: първият commit мина преди пълния suite — фейл от изтекъл env state (saveCredentials мутира SN_USER); поправено с `baselineEnv()` в finally и commit-ът е amend-нат. Дисциплината „пълен suite преди commit“ е още по-задължителна.
- **Q2-1+Q2-2 (`b8b9216`):** coverage праг в CI от реалния отчет (lines 89.9% → праг 85; branches 78.8% → 72); fast-check property тестове — 500 случайни стринга през formatEnvValue→dotenv round-trip (отказът е валиден изход) + 200 случайни буфера през base64 encode→strict decode→байтово равенство.
- **S2-3+Q2-3 (`ac14952`):** CI job `launcher-node12` (container node:12-alpine — човешко съобщение + ненулев изход); `windows-latest` job с continue-on-error до първия зелен run; build script-ът вече е кросплатформен (chmod през node fs, не unix команда).
- **A2-1 · PackageSpec (`5daad20`):** пакет = ЕДИН обект {name, tools, resources?} в PACKAGES манифеста; ALL_TOOLS се извежда; runtime инвариант (tool тагът ≡ манифестния пакет); registerResources е декларативен от манифеста (ръчният К-7 if изтрит); resources.ts стана три самостоятелни регистратора и цикълът resources→registry изчезна.
- **С тригери (не се правят сега):** S2-4/R-3 release процес (чака решение за публикуване), A2-2 (MI-1), A2-3 („когато заболи“), A2-4 (при Х-8), A2-5 (MCP протокола).
- **Паралелно (другата сесия):** R-1 MIT лиценз + R-4 npm метаданни (`fc1f62c`), R-6 единна бройка 49/14 (`08b71cc`), CI hygiene за coverage артефактите. R-5/R-7/R-8 се затвориха от моите commits.

## 2026-06-12 — release-readiness анализ (само анализ, кодът не е пипан)

### Задача

Иван поиска оценка колко готов е проектът за релийз по най-добрите стандарти.

### Стъпки

- [x] Реална верификация на Node 22: build чист, ESLint чист, **128/128 теста** (127 + 1 от некомитнатия WIP), coverage 89.4% lines / 78.2% branches / 62.5% functions.
- [x] `npm run verify` се проваля на Prettier — но само заради **некомитнатия WIP** в `src/mcp/registry.ts` (+ нов тест в `test/mcp-smoke.test.js`); HEAD версията е форматирана коректно.
- [x] `npm pack --dry-run`: 76 kB / 101 файла, само build+bin+README — нищо излишно не изтича.
- [x] `npm audit --omit=dev`: 0 уязвимости (3 runtime зависимости).
- [x] Находките оформени като чеклист **R-1…R-9** в TODO.md (нова секция „Release-readiness 2026-06-12“); дублираният won't-fix header махнат; компас редът за TODO.md в PRODUCT-STATE.md актуализиран.

### Изпълнение (същата вечер, по „започвай го“)

Решения на Иван: **MIT**, **засега без remote** (подготвено за push), **WORKLOG/.claude остават tracked** (изключение като syncrona). Паралелно течеше втора сесия (S2-1, Q2-1/Q2-2, S2-3/Q2-3 — commits `e879321`, `b8b9216`, `ac14952`), затова: стейджване само на конкретни файлове, никакъв `git add -A`, верификация в отделен worktree от HEAD.

- [x] **Хигиена:** `coverage/` в .gitignore/.prettierignore (`b0fe260`); 24-те комитнати c8 артефакта извадени от историята (`a3a388b`) — били пометени от bulk add в `e879321`.
- [x] **R-1+R-4:** LICENSE (MIT) + `license`/`author`/`prepublishOnly` в package.json (`fc1f62c`). Остават `repository`/`bugs`/`homepage` при remote.
- [x] **R-6:** pie 46→49 (+email:2, admin:3), CHANGELOG 46/12→49/14, тестова бройка → 131 (`08b71cc` + release cut).
- [x] **R-3:** CHANGELOG срязан на `[1.0.0] - 2026-06-12` (+ записи за strict zod, лиценза, property тестовете, CI gate); анотиран таг `v1.0.0`.
- [x] **Верификация:** worktree от HEAD + `npm ci` + `npm run verify` — build/lint/format чисти, **131/131 теста**. R-7/R-8 се оказаха свършени от паралелната сесия — само отметнати.

### Резултат — какво липсва за релийз (нищо не е поправяно)

1. **Блокер: няма LICENSE файл и няма `license` поле в package.json.**
2. **Блокер: няма git remote** — CI workflow-ът никога не е изпълняван реално.
3. package.json без `repository`/`author`/`bugs`/`homepage`; няма `prepublishOnly`.
4. Release процес липсва (известно — S2-4): версия 1.0.0 от началото, CHANGELOG само с [Unreleased], нула тагове.
5. Дребен doc drift: package.json казва „49 tools“, PRODUCT-STATE pie + CHANGELOG казват 46; TODO.md има дублиран header „Решения (won't-fix)“.

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

### Вечерен дийп ресърч: best practices пакет (commit `a84b6d5`) + троен анализ → TODO

- **Заявка на Иван:** дийп ресърч какво може да се подобри по най-добри практики + имплементация; после троен анализ какво липсва → в TODO лога.
- **Намерено и имплементирано:**
  1. **Невидим Prettier дрифт в 34 файла** — format:check липсваше от CI, дрифтът се трупаше тихо. Целият repo форматиран; `format:check` добавен в CI; README.md и docs/instance/ в `.prettierignore` (генерирано съдържание — prettier би разместил генерираната таблица и счупил sync теста).
  2. **`npm run verify`** — една команда = CI parity локално (build + lint + format:check + test).
  3. **Crash handlers** в index.ts: `unhandledRejection` се логва (не убива stdio сървъра), `uncaughtException` логва и излиза с код 1 — без недефинирано състояние.
  4. **Реален staleness бъг:** plugin availability кешът е ключуван по API label (не по host) — смяна на инстанцията в движение носеше до 5 мин чужд кеш; схема кешът също оставаше. `set_credentials` вече чисти всичко кеширано под старата идентичност (токени + схеми + plugin availability). `_resetPluginAvailability` → `clearPluginAvailability` (вече прод API, не тестов hook).
  5. **package.json хигиена:** description-ът лъжеше („Table API only“) — актуализиран; keywords добавени.
- **Троен анализ (какво ЛИПСВА)** — нова секция в [TODO.md](TODO.md): S2-1…S2-4 (strict zod схеми, per-host семафор/телеметрия за Фаза 7, launcher тест, release процес), A2-1…A2-5 (PackageSpec с resources/prompts в манифеста — следващата стъпка на модулността; ConfigStore обхват; singletons; transport разклонение при Х-8; resource грешките), Q2-1…Q2-5 (coverage праг, property-based тестове, Windows CI, перф тест за okQueryResult, elicitation accept път). Бек лог по приоритет — нищо не блокира.
- **Верификация:** `npm run verify` зелено (127/127).

### Фаза 6 финал: М-серията + Х-серията (122 → 127 теста) — „да се вкарват и изкарват модули“

- **Заявка на Иван (по време на работата):** проектът да е добре модулиран, със спазени ООП принципи и лесно вкарване/изкарване на модули. Това е точно М-3/М-4 — изпълнено.
- **М-1 (`5e6cd04`):** git mv на 14 файла в `core/` (ниво 0, без MCP SDK), `api/` (ниво 1, само core), `mcp/` (ниво 2, SDK), `tools/` (ниво 3); 56 import пътя пренаписани със скрипт + ръчна корекция на registry (частичен префикс не се хвана). Тестовите import-и обновени в същия commit (без shim-ове — по-чисто от плана). Нула промяна в поведение.
- **М-2 (`ab6c252`):** слоевите правила са машинно наложени — `no-restricted-imports` зони per директория; критерият проверен с нарочен api→mcp import (гръмна). `test_connection` логиката отиде в `api/diagnostics.ts`, за да спазва tools⇍core/http правилото, което сама наложи.
- **М-3+М-4 (`71b6058`) — сърцето на модулността:** нов `mcp/define.ts` с `ToolSpec` (име/докс/пакет/annotations/zod вход/logFields/handler — **един обект е целият инструмент**) и `runSpec` (uniform логване/грешки — tools/util.ts изтрит). 13-те tools файла станаха чисти данни: `export const specs: AnyToolSpec[]`. Registry-то е просто: `ALL_TOOLS = [...tableSpecs, ...metaSpecs, …]` — **пакет се вкарва/изкарва с един ред**; `ALL_PACKAGES` се извежда от данните; readonly-пакетите са филтър по `annotations.readOnlyHint` (Proxy фасадата изтрита); `describeAllTools()` чете манифеста директно (capturing stub-ът изтрит). **Доказателство за неизменност:** manifest snapshot-ът и README sync тестът минаха без регенерация — повърхността е байт-идентична след ~1500 реда рефакторинг.
- **Х-7 (`5f95db9`) — модулността на практика:** целият email пакет (api + 2 спека) влезе с 1 import + 1 spread; `all` профилът и README/манифестът го видяха автоматично. 49 tools, 14 пакета.
- **Х-2+Х-4+Х-5 (`f15bb5d`):** elicitation потвърждение за креденшъли (с graceful fallback за клиенти без capability — нищо не се чупи); MCP logging огледало през `setLogSink` (ниско прикачане — една точка в `emit()`); `outputSchema`+`structuredContent` опционално в спека, приложено само на двата стабилни диагностични tool-а — отклонението от плана (без query_table и пр.) е аргументирано: дублирането на structuredContent би удвоило токените, срещу които О-2 воюва.
- **Верификация на всяка стъпка:** build + lint (вкл. граничните правила) + пълният suite; 127/127.

### Фаза 6 спринт: одит + 17 задачи от плана (16 commit-а, 107 → 122 теста)

- **Заявка на Иван:** „всичко от имплементейшън плана да се провери и което е готово да отива по документите; след това продължавай каквото ти трябва“.
- **Одит (commit на одита):** всяка задача от Фаза 6 сверена срещу кода. Реално готови отпреди: П-1 (git, мой), Х-1 (SDK 1.29 — заварен), Х-3 (prompts.ts — заварен), М-5 (по същество = A-8). Всичко останало потвърдено като неготово. Планът отбелязан, DONE допълнен.
- **П-2 · Node 20+ защита (`2a84eb3`):** ключово прозрение — guard вътре в ESM граф **не може** да хване Node 12, защото целият граф се парсва преди да се изпълни каквото и да е (SyntaxError на SDK файловете идва първи). Затова: CJS launcher `bin/sincronia-mcp.cjs` (само Node-12-парсваем синтаксис; bin сочи към него) + втори guard в index.ts за директно стартиране (хваща 14–18) + `engines>=20` + `.npmrc engine-strict`. **Верифицирано под истински Node 12.22.12** — човешко съобщение, exit 1.
- **К-1+К-2 · OAuth устойчивост (`b48a4f1`):** 401 при oauth → `invalidateToken(host)` (чисти само ключовете на хоста) → еднократен retry с нов токен (флаг, не цикъл); Authorization вече се изчислява per attempt (при 8 s × N backoff токенът можеше да изтече между опитите). Тестове: 401→re-auth→200 с точен брой заявки; двойно 401 → грешка.
- **К-3 (`61cbd26`):** fetchAll без ORDERBY получава `^ORDERBYsys_id` — offset пагинацията беше нестабилна при паралелни писания. Експлицитният ORDERBY и single-page четенията не се пипат.
- **К-4 (`b10a50c`):** batch URL-ите изискват `/api/` префикс — `/oauth_token.do`, `/login.do` бяха достъпни през batch (същият хост, извън policy модела).
- **К-5 (`ff3e826`):** `^` в text/name/table филтрите се отхвърля с ясна грешка — то е разделителят на encoded query и SN няма escape; суров `^` тихо изкривяваше резултатите.
- **К-6 (`d0e2822`):** set_credentials вика resolveHost преди запис — невалиден/SSRF хост се отказва структурирано, без да пипне .env/process.env/store. Won't-fix решението за смяна на хост остава (това е формат валидация).
- **К-7 (`07006b5`):** resources се регистрират по пакетната политика (tables/schema → `schema`, docs → `docs`, status винаги); уважава и SN_PACKAGES_DENY.
- **К-8 (`5002c2d`):** CI матрица Node 20/22/24, c8 coverage стъпка (видимост, без праг), `npm test` вече не дублира build-а (CI го прави отделно; локално: `test:full`).
- **М-6 (`ae7d123`):** snapshot на пълния манифест `{name, package, title, annotations}` срещу чекирана JSON фикстура (`npm run gen:manifest`); describeAllTools носи пълните annotations. Всяка промяна по повърхността е видим diff.
- **О-1+О-2 (`05b0341`):** reference link URL-ите изключени по подразбиране (−20–40% токени; opt-out SN_INCLUDE_REF_LINKS); JSON изходът компактен (pretty ~×2 токени; opt-in SN_RESULT_PRETTY). Truncation сметката мери реалния размер.
- **О-3 (`103ab7f`):** нов src/cache.ts — `cached(key, fn)` с TTL от SN_SCHEMA_CACHE_TTL_SEC (300 s; 0 изключва), приложен хирургично само върху list_tables/describe_table (пести и веригата на наследяване — 2+ заявки) и get_cmdb_meta; ключът включва instance за Фаза 7.
- **О-4+О-5 (`84ccbb5`):** counting semaphore около fetch (SN_MAX_CONCURRENT=4) + телеметрия {requests, retries, errors по статус, totalMs} в status повърхностите. Тестове: max in-flight=2 при 6 паралелни; броячите след 429-retry и 403.
- **Х-6 (`373688b`):** servicenow_test_connection — диагностика „работи ли“, не само „какво е конфигурирано“: 1 запис от sys_user директно през snRequest (table deny не бива да маскира диагностиката), резултат {ok, status, latencyMs, user}; провалите са структурирани (ok:false), за да реагира моделът. Манифест + README регенерирани (47 tools); README Requirements → Node 20+.
- **Env дисциплина:** всяка нова променлива (SN_INCLUDE_REF_LINKS, SN_RESULT_PRETTY, SN_SCHEMA_CACHE_TTL_SEC, SN_MAX_CONCURRENT) е в README таблицата + .env.example в същия commit.
- **Оставащо от Фаза 6:** М-1/М-2 (директориите core/api/mcp + ESLint граници) и М-3/М-4 (декларативният манифест) — големият рефакторинг; Х-2/Х-4/Х-5/Х-7/Х-8.

### Архитектурна документация: ARCHITECTURE.md + PRODUCT-STATE.md

- **Заявка на Иван:** „md файлове за архитектурна документация; стейт на продукта — докъде какво как е направено; мермейд диаграми“.
- **Решение за структурата:** два файла с различни читатели — [ARCHITECTURE.md](ARCHITECTURE.md) отговаря на „как е устроено“ (за разработчик, влизащ в кода), [PRODUCT-STATE.md](PRODUCT-STATE.md) на „какво има и какво няма“ (за преглед на статуса). Дублирането с DONE/плана е съзнателно минимално: state файлът синтезира и сочи, не повтаря.
- **ARCHITECTURE.md (11 секции, 5 Mermaid диаграми):** слоеста графика на модулите (bootstrap → MCP повърхност → API слой → ядро, с реалните зависимости вкл. съзнателния import цикъл registry↔admin↔status); sequence диаграма на пълния жизнен цикъл на заявка (zod → policy → ConfigStore → SSRF → auth → fetch → retry → truncation → плик, вкл. retry матрицата 429/503 за всички методи срещу 502/504/transport само за GET); flowchart на двуосовия модел на сигурност (ос таблици + ос пакети + SSRF + какво нарочно НЕ пази — won't-fix решенията); auth диаграма (Basic/OAuth, кеш ключ без парола → защо има invalidateTokens); package gating диаграма (env → resolve → deny → readonly фасада → describeAllTools → README генератор). Плюс: конфигурационният модел (env-first + ConfigStore snapshot), грешки/резултати, тестовата архитектура като таблица по нива и **7 съкратени ADR-а** с отхвърлените алтернативи. Завършва с архитектурното бъдеще (Фази 6–8, една препратка).
- **PRODUCT-STATE.md (7 секции, 2 Mermaid):** TL;DR; покритие на ServiceNow API повърхността (16 реда: ✅ покрито / 📋 планирано с точните задачи от плана); как е направено (качество/инфраструктура); pie диаграма на 46-те tool-а по пакети (сборът проверен = 46); timeline на историята 06-11 → 06-12; пътна карта (Фази 6–8 + опционално, с обеми); известни ограничения и съзнателни решения; документен компас (кой файл за какво — за да не се чуди никой къде да гледа).
- **README:** нова секция „Project documentation“ с таблица-компас към всичките MD документи (на английски, като останалото README).
- **Проверки:** числата сверени с реалността (`git rev-list --count` = 23 с този commit; tools = 46; тестове 107); pie сборът ръчно проверен; Mermaid синтаксисът прегледан конструкция по конструкция (subgraph/alt/dotted edges/timeline sections). 107/107 след промяната (README sync тестът пази генерираната секция — добавката е извън маркерите).

### A-2 · ConfigStore за креденшълите (commit `290a346`)

- **Контекст:** последната ВИСОКА находка от ревюто. `set_credentials` мутираше `process.env` + файла, а всеки модул четеше env при всяко извикване — креденшълите нямаха собственик, а Фаза 7 (мулти-инстанс профили) щеше да умножи разпръснатите четения.
- **Обмислени варианти:** (а) _read-through store_ (чете env при всяко извикване) — отхвърлен: нулева промяна спрямо сегашното, само индирекция; (б) _пълен ConfigStore за всички SN_\* настройки\_ (policy, settings, OAuth) — отхвърлен за сега: планът нарочно слага това след М-1/М-2 преместването в `core/`, иначе рефакторингът се прави два пъти; (в) **снапшот store само за креденшълите** — избран: малък, дава структурна атомарност и е точно опорната точка, която MI-1 ще разширява до профили.
- **Имплементация ([config.ts](src/config.ts)):** модулен `let store: ServiceNowCredentials | null`; `getCredentials()` прави snapshot от env при първото четене и след това връща **копие** на същия immutable обект (защитно копиране — мутирал резултат не отравя store-а); `saveCredentials()` пише env файла + `process.env` (за child процеси/back-compat) и накрая сменя snapshot-а с **едно присвояване** — четене „нов user + стара парола“ е структурно невъзможно; нов експорт `reloadCredentialsFromEnv()` — викан от `loadEnv()` при старт и от тестовете.
- **Тестова адаптация:** [test/helpers.js](test/helpers.js) — `baselineEnv()` и `withEnv()` презареждат store-а след staging на env (без това всички тестове, мутиращи SN_INSTANCE/USER/PASSWORD, биха виждали стар snapshot). Нов [test/config-store.test.js](test/config-store.test.js): (1) директна env мутация без reload НЕ тече към четците (store контрактът), а reload я взима; (2) snapshot-ът е копие; (3) `saveCredentials` с `SN_ENV_FILE` в temp dir — персист, swap, недокоснати ключове отсъстват от файла.
- **Верификация:** build + lint + 105/105. **Файлове:** `src/config.ts`, `test/helpers.js`, `test/config-store.test.js`.

### A-8 · README tools таблицата се генерира от кода (commit `5bd5489`)

- **Контекст:** README имаше 46-редова ръчно поддържана таблица на tools — изоставаше при всяка промяна (вече липсваха новите анотации). Планът отлагаше това за М-5 след манифеста М-3.
- **Ключово решение:** не чакаме манифеста. Регистрациите СА източникът на истина — нов `registry.ts#describeAllTools()` прави replay на всички `register*Tools` срещу capturing stub (обект само с `registerTool`, който записва `{package, name, title, description, readOnly}`), без сървър и без мрежа. Когато М-3 дойде, функцията се опростява, но интерфейсът и генераторът остават.
- **Генератор ([scripts/readme-tools.mjs](scripts/readme-tools.mjs)):** строи таблица `Package | Tool | Read-only | Description` (описание = първото изречение, pipe-escaped, ограничено до 110 знака) и я слайсва между `GENERATED:TOOLS` маркери в README; `npm run docs:readme`. Ръчната таблица е заменена — съзнателно жертваме ръчно изгладените описания за гаранция срещу drift.
- **Пазач:** [test/readme-sync.test.js](test/readme-sync.test.js) — (1) README секцията се сравнява символ по символ с генерираната (съобщението при провал казва точно какво да пуснеш); (2) всеки от 13-те пакета допринася tools и всеки tool има име/описание/readOnly флаг.
- **Останало от A-8:** env таблицата в README е още ръчна — отбелязано в плана (М-5 се свежда до нея).
- **Верификация:** 107/107. **Файлове:** `src/registry.ts`, `scripts/readme-tools.mjs`, `test/readme-sync.test.js`, `README.md`, `package.json` (нов script).

### Q-6 + финално разчистване на TODO.md

- **Q-6 (процедурно) — институционализирано:** правило 7 в плана (6.6): всяка поведенческа промяна влиза с тест в същия commit; пазачите са автоматични — README sync тестът, контрактният snapshot на core профила и пълният suite. Недисциплинирана промяна чупи поне един.
- **Старите опционални точки от 2026-06-11** разпределени по местата им: trust boundary → плана Х-2 (elicitation, вече описана там); MCP logging capability → Х-4; PDI integration suite + Export API → нова секция „Опционално“ в плана; roadmap елементът — изчерпан (всичко изброено е покрито или планирано, Email = Х-7); „Changelog при публикуване“ — **затворен със създаден [CHANGELOG.md](CHANGELOG.md)** (Keep a Changelog, `[Unreleased]` обобщава текущото състояние).
- **Краен резултат:** TODO.md съдържа единствено двете won't-fix решения (с бележка какво да се направи, ако някога спрат да са won't-fix). Всичко друго: имплементирано → DONE.md, или планирано → IMPLEMENTATION-PLAN.md. **Ревюто 2026-06-12: 22/22 затворени.**

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
