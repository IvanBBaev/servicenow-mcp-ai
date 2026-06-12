# TODO — Код ревю (синиър програмист)

Дата: 2026-06-11 · Обхват: `src/index.ts`, `src/servicenow.ts`, `src/config.ts`, конфигурация на проекта.

> **Статус:** всички поправени елементи са преместени в [DONE.md](DONE.md).
> Тук остават само двата елемента, маркирани „не е проблем“ — съзнателно решение на потребителя, без промяна по кода.

## Решения (won't-fix)

- [~] **`.env` се записва с права 0644 (четим от всички локални потребители).**
  Пропуснато — не е проблем (решение на потребителя).
  `config.ts:102` — `writeFileSync` ползва default mode. Файлът съдържа парола в plaintext.
  → Подай `{ mode: 0o600 }` при запис и при нужда `chmodSync` на съществуващ файл.

- [~] **`servicenow_set_credentials` позволява пренасочване на Basic auth към произволен хост.** и това не е проблем
  Пропуснато — не е проблем (решение на потребителя). SSRF guard-ът за вътрешни/loopback хостове остава активен.
  `index.ts:189-226` + `servicenow.ts:38-44` — ако `instance` бъде сменен на `evil.com` (напр. чрез prompt injection), всички следващи заявки изпращат user/password като Basic auth към чужд сървър.
  → Валидирай, че хостът завършва на `.service-now.com` (или изисквай изричен opt-in флаг/env за custom домейни).


# TODO — Архитектурно ревю

Дата: 2026-06-11 · Обхват: цялостен дизайн на Sincronia ServiceNow MCP сървъра.

> **Статус:** по-голямата част от ревюто е изпълнена и преместена в [DONE.md](DONE.md).
> Тук остават отворените решения и опционалните разширения.

## Модел на сигурност и доверие

- [ ] **Trust boundary за credentials — частично адресирано.**
      `servicenow_set_credentials` все още позволява на модела да пише в env и да сменя хоста. Вече има митигиращи мерки: SSRF guard за вътрешни хостове, `SN_ALLOWED_HOSTS`, table allow/deny и `SN_READONLY`. Остава (по избор): клиентска конфирмация (MCP elicitation) преди запис на credentials, или режим, в който credentials идват само от env/клиента, а инструментът се изключва.

## MCP дизайн

- [ ] **MCP `logging` capability (по избор).**
      Структурираното логване на stderr с `SN_LOG_LEVEL` е готово (виж [DONE.md](DONE.md)). Остава по желание: пробутване на логове към клиента по протокола чрез MCP `logging` capability.

## Качество и жизнен цикъл

- [ ] **Integration suite срещу ServiceNow PDI (по избор).**
      Unit + mock-fetch тестове и CI са готови (виж [DONE.md](DONE.md)). Остава по желание: end-to-end suite зад env флаг срещу жив PDI инстанс.

- [ ] **Roadmap: останали ServiceNow API-та.**
      Покрити са Table, Aggregate (Stats), Attachment, Import Set и метаданни (`sys_db_object` / `sys_dictionary`). Кандидати за следваща итерация (по приоритет): Batch API, Service Catalog API, Identification/Reconciliation, Export (CSV/Excel), Knowledge. Записвай решенията в README.

- [ ] **Changelog при публикуване (по избор).**
      Версията е с единен източник от `package.json` (виж [DONE.md](DONE.md)). Остава по желание: CHANGELOG при публикуване на пакета.

---

# TODO — Дълбоко ревю 2026-06-12 (синиър дев · архитект · QA)

Обхват: целият `src/` (24 файла), `test/` (8 файла, 50 теста), tsconfig/eslint/CI. Build, lint и тестовете са зелени преди ревюто (Node 22).
Конвенции: ID-та `S-*` (синиър дев), `A-*` (архитект), `Q-*` (QA). Където находка се припокрива със задача от IMPLEMENTATION-PLAN.md Фаза 6 — дадена е препратка, без дублиране. Решенията „won't-fix“ от 2026-06-11 (права на `.env`, смяна на instance) не се повдигат отново.

## Синиър девелопер — находки по кода

- [ ] **S-1 · КРИТИЧНО: `describeTable` пропуска наследените колони.** [api/meta.ts:50](src/api/meta.ts#L50) пита `sys_dictionary` с `name=${table}` — но в ServiceNow наследените полета живеят на родителската таблица. За `incident` това значи: без `short_description`, `priority`, `state`, `assigned_to`… (всички са дефинирани на `task`). Инструментът, чиято цел е „какви полета има таблицата“, връща малка част от тях — LLM-ът ще греши при всеки create/update на разширена таблица. _Поправка:_ изгради веригата на наследяване от `sys_db_object.super_class` (итеративно до корена), после питай `sys_dictionary` с `nameIN<веригата>^elementISNOTEMPTY`; дедуплицирай по `element` (override-ите при детето печелят). Засяга и resource `servicenow://schema/{table}` и бъдещия ER генератор (Фаза 5). _Тест:_ mock на двустепенна верига incident→task; асерция, че полета и от двете нива присъстват.
- [ ] **S-2 · ВИСОКО: `listTables` връща label вместо име в `superClass`.** [api/meta.ts:27](src/api/meta.ts#L27) чете с `displayValue: "true"` — `super_class` е reference и идва като display стойност („Task“), не като име (`task`). Прави полето неизползваемо за обхождане на наследяването (нужно и за S-1). _Поправка:_ `displayValue: "all"` и вземи `value` за super_class (+ display за label), или второ четене raw. _Тест:_ mock с reference обект `{value, display_value}`.
- [ ] **S-3 · СРЕДНО: невалиден base64 при upload минава тихо.** [api/attachment.ts:73-78](src/api/attachment.ts#L73-L78) — `Buffer.from(s, "base64")` никога не хвърля (декодира best-effort), затова try/catch-ът е мъртъв код и невалиден вход качва повреден файл. _Поправка:_ валидирай явно (regex `^[A-Za-z0-9+/=\s]+$` + проверка, че `Buffer.from(s,"base64").toString("base64")` нормализирано съвпада, или поне че дължината е консистентна); при провал — ясна грешка без HTTP заявка. _Тест:_ `contentBase64: "не-base64!"` → грешка, нула fetch извиквания.
- [ ] **S-4 · СРЕДНО: `downloadAttachment` тегли целия файл преди проверката за размер.** [api/attachment.ts:106-122](src/api/attachment.ts#L106-L122) — guard-ът срещу SN_MAX_RESULT_CHARS идва **след** `arrayBuffer()`; attachment от 1 GB се сваля изцяло в паметта само за да бъде отказан. _Поправка:_ първо `getAttachmentMeta` → `size_bytes`; ако `ceil(size*4/3) > maxChars` → откажи преди download (съобщението вече е правилното). _Тест:_ meta с голям size_bytes → грешка, file endpoint-ът не е извикан.
- [ ] **S-5 · НИСКО: `servicenow_aggregate` позволява извикване без нито една агрегация.** Без count/avg/min/max/sum заявката стига до инстанцията и се връща SN грешка. _Поправка:_ проверка в handler-а ([tools/aggregate.ts:51](src/tools/aggregate.ts#L51)): поне едно от петте → иначе `fail("Изисква се поне една агрегатна функция…")` без мрежово извикване.
- [ ] **S-6 · СРЕДНО: table policy в batch не покрива не-Table под-заявки.** [api/batch.ts:67-69](src/api/batch.ts#L67-L69) — `tableFromUrl` разпознава само `/api/now/table/...`; под-заявка към `/api/now/stats/incident`, `/api/now/import/...` или `/api/now/cmdb/instance/...` минава **без** `assertTableAllowed` (write guard-ът работи). Дени-нат `incident` е достъпен за четене през batch+stats. _Поправка:_ разшири извличането: `/api/now/(stats|import|table)/{x}` и `/api/now/cmdb/instance/{class}`; за неразпознати `/api/now/*` пътища с таблично-подобен сегмент — прилагай проверката консервативно. Допълва К-4 от Фаза 6 (ограничаване до `/api/`), не го замества. _Тест:_ deny на `incident` + batch със stats URL → 403 преди мрежата.
- [ ] **S-7 · НИСКО: OAuth кешът не се чисти при смяна на креденшъли.** Ключът е `host|clientId|grant|username` ([auth.ts:117](src/auth.ts#L117)) — паролата/secret-ът не участват. След `set_credentials` с нова парола (същия user) старият валиден токен продължава да се ползва — объркващо при ротация/тестове. _Поправка:_ `saveCredentials` (или К-1 `invalidateToken`) чисти кеша за host-а. (Свързано с К-1 от Фаза 6 — реши ги заедно.)
- [ ] **S-8 · НИСКО: търсеният текст отива в логовете.** [tools/scripts.ts:113](src/tools/scripts.ts#L113) подава `{ text: args.text }` към `runTool` → INFO лога, в разрез със собственото правило на [logging.ts](src/logging.ts) („never raw encoded queries / personal data“). _Поправка:_ логвай `{ textLength: args.text.length, type: args.type }`.

## Архитект — дизайн находки

- [ ] **A-1 · ВИСОКО: policy моделът е таблично-центричен, а половината повърхност не е таблици.** `SN_TABLES_ALLOW/DENY` пази Table API, CMDB, Import Set и (частично) Batch — но Catalog/Change/Knowledge/Aggregate-by-stats/Attachment-by-sys_id минават само през read-only guard-а. Дениваш `change_request` → Change API пак чете и пише change-ове; дениваш всичко освен `incident` → каталожна поръчка пак минава. Това не е имплементационен пропуск на едно място (S-6 е частният случай), а липсваща втора ос в модела. _Решение:_ per-package policy: `SN_PACKAGES_DENY` / `SN_PACKAGES_READONLY` (напр. `change,catalog`), прилагани в `registry.ts` при регистрация (не регистрирай / регистрирай само read tools). Естествено се слива с per-profile policy от Фаза 7 (MI-2). Като минимум преди това: README да казва експлицитно, че table deny ≠ plugin API deny.
- [ ] **A-2 · ВИСОКО: `process.env` като глобално mutable хранилище за креденшъли.** `set_credentials` мутира env + файл; всеки модул чете env при всяко извикване. Последици: (а) тестовете задължително жонглират env на module ниво (всеки от 8-те файла — крехко, виж Q-2); (б) заявка по време на смяна може да види нов user + стара парола (никаква атомарност); (в) Фаза 7 профилите ще умножат проблема. _Решение:_ `ConfigStore` обект в core: атомарен `get()` snapshot / `set()`, env e само началният източник; auth/http/policy четат от store-а. Това е и правилната основа за MI-1 — направи го **преди** мулти-инстанс работата.
- [ ] **A-3 · СРЕДНО: `pluginCall` не е capability detection.** Планът обещава „probe → 404 = няма го“, реализацията само украсява 404 текста ([api/plugin.ts](src/api/plugin.ts)). Истинско откриване: при първи 404 за namespace кеширай „API X недостъпно“, експонирай наличността в `servicenow_get_status` + `servicenow://status`, и връщай мигновен отказ (без HTTP) до изтичане на TTL. Слива се с MI-6 (плъгин списъка в снапшота).
- [ ] **A-4 · СРЕДНО: осем копия на `if (!data || data.result == null) throw`.** servicenow.ts ×4, attachment ×3, meta и пр. — всяко ново API копира шаблона. _Решение:_ `expectResult<T>(resp, label)` helper в core (или в бъдещия `api/_shared.ts`); едно място, един тест. Влиза естествено в М-1 преместването.
- [ ] **A-5 · НИСКО: status payload-ът се строи на две места** — [tools/admin.ts:73-85](src/tools/admin.ts#L73-L85) и [resources.ts:43-52](src/resources.ts#L43-L52), вече разминати (resource-ът няма `enabledPackages`). _Решение:_ общ `buildStatusPayload()`; двете места го викат.
- [ ] **A-6 · СРЕДНО: tsconfig без `noUncheckedIndexedAccess`.** Код, който постоянно индексира външни `SnRecord`-и и масиви ([api/scripts.ts](src/api/scripts.ts) `lines[i]`, `records[0]`…), печели реална защита от това правило. _Действие:_ включи го, поправи изскочилите (очаквано: шепа `?.`/guard-ове). `exactOptionalPropertyTypes` — по желание, по-шумно.
- [ ] **A-7 · СРЕДНО: ESLint без type-checked правила.** Сегашният flat config е само `recommended` — не хваща floating promises (реален риск при async tool handler-и: забравен `await` → недочакан resource cleanup / error mapping). _Действие:_ `tseslint.configs.recommendedTypeChecked` + изрично `@typescript-eslint/no-floating-promises: error`; `parserOptions.projectService: true`. Поправи изскочилото.
- [ ] **A-8 · НИСКО: README дублира ръчно поддържана истина** (списък tools, env таблица) — решава се от М-5 (генерирана секция); тук само потвърждение, че е правилният приоритет след манифеста.

## QA — тестова стратегия и липсващи покрития

- [ ] **Q-1 · ВИСОКО: tools/ слоят (MCP повърхността) е без нито един тест.** Тестовете покриват api/ функциите, но никой не инстанцира McpServer: zod схемите, snake_case→camelCase мапингът на аргументи (напр. [tools/cmdb.ts:114-121](src/tools/cmdb.ts#L114-L121) — разместване на `sys_id`/`class_name` няма да се хване), `ok()` опаковките и annotations не се проверяват. _Действие:_ лек in-memory тест: SDK `Client` + `Server` през `InMemoryTransport` (SDK-то го предоставя), mock fetch отдолу → `listTools()` (брой + имена срещу фикстура — застъпва М-6) и по един `callTool` happy-path per пакет. След М-3/М-4 манифестът прави това още по-лесно (handler-ите са директно викаеми).
- [ ] **Q-2 · СРЕДНО: env мутации на module ниво във всеки тест файл.** Работи, защото `node --test` изолира файловете в процеси; всяка миграция към общ runner (vitest по плана!) ще счупи скрити зависимости. _Действие:_ общ `test/helpers.js` с `withEnv(overrides, fn)` (snapshot/restore) и `withFetch` (вече копиран 4 пъти — премести го там); тестовете мигрират постепенно.
- [ ] **Q-3 · ВИСОКО: конкретни непокрити поведения** (всички са в харнеса, всички се тестват с mock fetch, без мрежа):
  - `fetchAll` пагинация — няколко страници, спиране при къса страница, SN_MAX_RECORDS cap ([servicenow.ts:74-90](src/servicenow.ts#L74-L90)) — **нула тестове за най-сложния цикъл в кодовата база**;
  - `okQueryResult` truncation (halving цикъла, бележката, нулевия случай) ([result.ts:60-96](src/result.ts#L60-L96));
  - retry при transport грешка: GET се повтаря, POST — не ([http.ts:143-151](src/http.ts#L143-L151)); Retry-After като HTTP дата (парсва се на [http.ts:57](src/http.ts#L57));
  - download size guard (S-4 ще го промени — тествай новото поведение);
  - `pluginCall` 404 декорацията; `positiveInt`/`getMaxRetries` fallback-ите при NaN/отрицателни; logging level филтъра;
  - resources handlers (поне `servicenow://status` shape).
- [ ] **Q-4 · СРЕДНО: smoke тест на целия сървър.** Един тест, който стартира реалния entry (`registerAllTools` + `registerResources` върху Server с InMemoryTransport) и проверява: брой tools при `core` профил, брой при `all`, че admin tools са винаги там. Хваща wiring регресии (счупен import, пакет изпаднал от списъка), които unit тестовете по дефиниция не виждат. Застъпва се с Q-1 — реализирай ги заедно.
- [ ] **Q-5 · НИСКО: нетествани env override-и** — SN_TIMEOUT_MS, SN_MAX_RESULT_CHARS, SN_LOG_LEVEL: по един тест на парсинга (валиден/невалиден/липсващ) в нов `test/settings.test.js`.
- [ ] **Q-6 · процедурно: тест дисциплина за новите фази.** Всяка задача от Фаза 6–8 с поведенческа промяна влиза с тест в същия commit (правилото вече е в плана — тук е напомнянето, че Q-1/Q-3 първо запълват старите дупки, за да не се градят нови върху непокрита основа).

## Препоръчан ред

1. **S-1 + S-2** (двойката е една задача — наследяването на схемата) — най-голямата функционална печалба.
2. **Q-3 fetchAll + Q-1 in-memory harness** — предпазна мрежа преди рефакторингите от Фаза 6.
3. **S-6, S-3, S-4, S-7** — policy/attachment коректност (заедно с К-1…К-8 от Фаза 6 стъпка 1).
4. **A-2 ConfigStore** — преди Фаза 7; **A-1 per-package policy** — заедно с MI-2.
5. **A-6, A-7** (компилатор/линтер втвърдяване) — по всяко време, самостоятелни.
6. Останалите ниски приоритети — опортюнистично, при докосване на съответния файл.
