# TODO — статус към 2026-06-12

> **Ревюто от 2026-06-12 е изцяло имплементирано.** Всичките 22 находки (S-1…S-8, A-1…A-8, Q-1…Q-6)
> са затворени — резюметата с commit референции са в [DONE.md](DONE.md), подробната хронология в
> [WORKLOG.md](WORKLOG.md), а git историята е commit-по-задача (`git log --oneline`).
>
> Незапочнатите идеи живеят в [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md): Фази 6–8 за Opus 4.8,
> вкл. Х-2 (elicitation за set_credentials — стария trust-boundary елемент), Х-4 (MCP logging
> capability) и секцията „Опционално“ (PDI integration suite, Export API). CHANGELOG.md е създаден.
>
> Тук остават само съзнателните решения „won't-fix“ — те не са задачи.

## Решения (won't-fix) — без промяна по кода

- [~] **`.env` се записва с права 0644 (четим от всички локални потребители).**
  Пропуснато — не е проблем (решение на потребителя).
  `config.ts` — `writeFileSync` ползва default mode. Файлът съдържа парола в plaintext.
  → Ако някога потрябва: `{ mode: 0o600 }` при запис + `chmodSync` на съществуващ файл.

- [~] **`servicenow_set_credentials` позволява пренасочване на Basic auth към произволен хост.**
  Пропуснато — не е проблем (решение на потребителя). SSRF guard-ът за вътрешни/loopback хостове
  и `SN_ALLOWED_HOSTS` остават активни; Х-2 (elicitation) от плана добавя потвърждение от клиента.
  → Ако някога потрябва: изискване хостът да завършва на `.service-now.com` без изричен opt-in.
