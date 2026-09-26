# Service catalog — profile `default`

Generated from the catalog definitions (sc_catalog, sc_category, sc_cat_item, item_option_new; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.

- **Catalogs:** 2
- **Categories:** 2
- **Items:** 2
- **Item variables:** 3

## Purpose

<!-- sn:manual:start purpose -->
<!-- sn:manual:end -->

## Catalogs

| Catalog | Active | Categories | Items |
| --- | --- | --- | --- |
| Service Catalog | yes | 2 | 1 |
| Technical Catalog | no | 0 | 2 |

## Categories

| Category | Catalog | Parent | Active |
| --- | --- | --- | --- |
| Hardware | Service Catalog |  | yes |
| Laptops | Service Catalog | Hardware | yes |

## Items

| Item | Class | Category | Catalogs | Active | Variables |
| --- | --- | --- | --- | --- | --- |
| Request access | `sc_cat_item_producer` |  | Technical Catalog | yes | 1 |
| Standard laptop | `sc_cat_item` | Laptops | Service Catalog, Technical Catalog | yes | 2 |

## Variables

### Request access

| Order | Name | Question | Type | Mandatory | Active |
| --- | --- | --- | --- | --- | --- |
| 100 | `role` | Role \| level | Reference | yes | yes |

### Standard laptop

| Order | Name | Question | Type | Mandatory | Active |
| --- | --- | --- | --- | --- | --- |
| 100 | `model` | Model | Select box | no | yes |
| 200 | `justification` | Why do you need it? | Multi line text | yes | yes |

## Caveats

- Variables that come from a variable set are not listed per item; only variables attached directly to an item are.
- Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.
- Metadata only: built from dictionary, automation and access-control definitions; no business records were read.
