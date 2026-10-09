# `knowledge` tools

_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._

3 tools (3 read-only, 0 write). Opt-in: add `knowledge` to `SN_TOOL_PACKAGES`, or call `servicenow_enable_package`. [All packages](README.md).

| Tool | Read-only | Title |
| ---- | :-------: | ----- |
| [`servicenow_search_knowledge`](#servicenow_search_knowledge) | yes | Search knowledge articles |
| [`servicenow_get_knowledge_article`](#servicenow_get_knowledge_article) | yes | Get knowledge article |
| [`servicenow_get_knowledge_highlights`](#servicenow_get_knowledge_highlights) | yes | Featured / most-viewed knowledge |

## servicenow_search_knowledge

**Search knowledge articles.** Full-text search of knowledge articles (Knowledge API), with optional encoded query and paging.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `search` | string | no | Free-text search terms. |
| `query` | string | no | Extra encoded query. |
| `fields` | string[] | no | Fields to return. |
| `limit` | integer | no |  |
| `offset` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |

## servicenow_get_knowledge_article

**Get knowledge article.** Get a knowledge article (content and metadata) by sys_id.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `sys_id` | string | yes | Article sys_id. |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |

## servicenow_get_knowledge_highlights

**Featured / most-viewed knowledge.** List featured or most-viewed knowledge articles for the current user.

**Writes:** Read-only.

### Parameters

| Name | Type | Required | Description |
| ---- | ---- | :------: | ----------- |
| `mode` | "featured" \| "most_viewed" | yes | Highlight list. |
| `limit` | integer | no |  |
| `instance` | string | no | Profile (default active) |

### Output

Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).

| Field | Type | Description |
| ----- | ---- | ----------- |
| `result` | any |  |
