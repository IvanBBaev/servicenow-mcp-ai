# Translation coverage — `x_acme`

Generated from the scope's translation tables and UI Builder macroponents (the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

Scope `x_acme` · 1 macroponent(s) · base language `en` · languages from given.

## Sources

| Category | Table | Status | Keys | Rows |
| --- | --- | --- | --- | --- |
| UI messages | sys_ui_message | read | 2 | 4 |
| Field labels | sys_documentation | read | 2 | 3 |
| Choices | sys_choice | read | 2 | 2 |
| Translated text | sys_translated_text | read | 0 | 0 |
| Translated fields | sys_translated | read | 2 | 2 |
| UIB strings | sys_ui_message | read | 2 | 1 |

## Coverage

| Language | Translated | Missing | Total | Coverage |
| --- | --- | --- | --- | --- |
| de | 5 | 5 | 10 | 50 % |

## Missing: de

- UI messages: 1 of 2 — `Bye`
- Field labels: 1 of 2 — `x_acme_request.state`
- Choices: 1 of 2 — `x_acme_request.state.2`
- Translated fields: 1 of 2 — `x_acme_request.u_category.Software`
- UIB strings: 1 of 2 — `Save record`

## Caveats

- Translation coverage (N-7) is unverified (gate O-5): sys_ui_message (key, language), sys_documentation (name, element, language), sys_choice (name, element, value, language), sys_translated_text (tablename, fieldname, documentkey, language), sys_translated (name, element, value, language), sys_language (id, name, active) and the UIB message-key convention (the English string is the sys_ui_message key) are assumptions. The keys of a category are those seen in any language, so a value never translated into any language is not counted.
