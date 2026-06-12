# Changelog

Форматът следва [Keep a Changelog](https://keepachangelog.com/); версиите — [SemVer](https://semver.org/).
Пълната хронология на разработката е в [WORKLOG.md](WORKLOG.md); git историята е commit-по-задача.

## [Unreleased]

### Added

- Пълно ServiceNow API покритие отвъд Table API: Aggregate (Stats), Attachment, Import Set, Batch, Service Catalog, Change Management, Knowledge, CMDB Instance/Meta (IRE) — 46 tool-а в 12 пакета зад `SN_TOOL_PACKAGES` (профили `core`/`all`).
- Script intelligence (read-only): списък/четене/търсене в скриптове, `servicenow_table_logic`; Mermaid генератори (ER диаграма, table flow); локална само-документация (`docs` пакет) + MCP resources и prompts.
- Per-package policy: `SN_PACKAGES_DENY` и `SN_PACKAGES_READONLY` — контрол върху plugin API-тата, които table policy не вижда.
- Capability кеш за plugin API-та: namespace 404 се кешира 5 мин (fail-fast), наличността се вижда в `pluginApis` на статуса.
- ConfigStore: креденшълите са атомарен in-memory snapshot (env-ът е само начален източник).
- README tools таблицата се генерира от живите регистрации (`npm run docs:readme`) и се пази синхронна с тест.
- In-memory MCP smoke тестове (SDK Client + InMemoryTransport) с контрактен snapshot на `core` профила; 107 теста общо.

### Fixed

- `servicenow_describe_table` виждаше само собствените колони на таблицата — сега обхожда веригата на наследяване (за `incident` се връщат и полетата от `task`); `superClass` е истинско име на таблица, не label.
- Batch policy покрива и `stats`/`import`/`cmdb` под-заявки; невалиден base64 при upload се отказва преди мрежата; download не тегли байтовете преди проверката за размер; OAuth кешът се чисти при смяна на креденшъли.
- `String()` върху ServiceNow поле при `display_value=all` вече не произвежда `"[object Object]"` (`snString`).

### Changed

- TypeScript: `noUncheckedIndexedAccess`; ESLint: type-checked правила + `no-floating-promises`.
- Грешките са структурирани (`{ status, message, snDetail }`); retry с exponential backoff + `Retry-After`; SSRF guard; result size guard.
