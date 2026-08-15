# apexdoc

[![Security audit](https://github.com/alcabon/apex-doc/actions/workflows/security-audit.yml/badge.svg)](https://github.com/alcabon/apex-doc/actions/workflows/security-audit.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Salesforce Apex](https://img.shields.io/badge/Salesforce-Apex-00A1E0?logo=salesforce&logoColor=white)](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/)
[![License](https://img.shields.io/badge/license-ISC-blue)](LICENSE.txt)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757?logo=anthropic&logoColor=white)](https://claude.com/claude-code)

A JavaDoc-style documentation generator for Salesforce Apex, built on
[`@apexdevtools/apex-parser`](https://github.com/apex-dev-tools/apex-parser).

It does three things:

| Command | What it does |
| --- | --- |
| `generate` | Renders an HTML site, Markdown pages and/or a JSON model |
| `annotate` | **Writes doc comments into your `.cls` files** — stubs for what is undocumented, missing `@param`/`@return` for what is |
| `check` | Reports undocumented and inconsistent members, with coverage figures |

Building it from source, the toolchain and the internals are covered in
[DEVELOPER.md](DEVELOPER.md).

## Requirements

- Node.js 22 or newer
- The Apex you want documented, as `.cls` files

## Quick start

```bash
npm install
npm run build          # compiles src/**/*.ts to dist/

# Generate docs for the bundled examples into ./apexdocs
npm run docs
```

Open `apexdocs/html/index.html` in a browser.

Point it at your own code:

```bash
node dist/apexdoc.js generate force-app -o docs -f html
node dist/apexdoc.js annotate force-app/main/default/classes --dry-run
node dist/apexdoc.js check force-app --access public --strict
```

To get a plain `apexdoc` command on your PATH, see
[DEVELOPER.md → Installing the CLI globally](DEVELOPER.md#installing-the-cli-globally).

## Commands

```
apexdoc generate <path...> [options]   Render documentation
apexdoc annotate <path...> [options]   Insert or complete doc comments in the source
apexdoc check    <path...> [options]   Report undocumented or inconsistent members

  -o, --out <dir>          Output directory                     (default: apexdocs)
  -f, --format <list>      html, md, json — comma separated     (default: html,md)
  -a, --access <level>     Lowest visibility to document:
                           global | public | protected | private (default: protected)
  -t, --title <text>       Project title                        (default: Apex Documentation)
      --placeholder <text> Filler used in generated comments    (default: TODO)
      --no-complete        annotate: leave existing comments untouched
      --dry-run            annotate: report the changes without writing
      --backup             annotate: keep a .bak copy of every rewritten file
      --header <file>      annotate: file header template for top-level types
      --author <name>      annotate: fills {{author}} in the header template
      --group <name>       annotate: fills {{group}} in the header template
      --doc-version <text> annotate: fills {{version}} (default: today's date)
      --strict             check: exit 1 on warnings as well as errors
  -h, --help               Show this message
```

A path may be a single `.cls` file or a directory, which is scanned recursively.
`node_modules`, `.git`, `.sfdx`, `.sf`, `dist` and `out` are skipped.

### `generate`

Output is written under `--out`:

```
apexdocs/
  html/
    index.html      overview, grouped by @group, with coverage stats
    styles.css      light and dark, no external assets
    <Type>.html     one page per top-level type
  markdown/
    README.md       index
    <Type>.md       one page per top-level type
  apexdoc.json      the full model, for your own tooling
```

Each type page follows the JavaDoc layout: signature, description and tags,
then **Constructor / Field / Property / Method Summary** tables, then the
matching detail sections. Nested classes, interfaces and enums are documented
on their parent's page and linked from a Nested Type Summary.

The HTML site is static and self-contained — no CDN, no build step, no server.
It has a sidebar type list with a filter box, and follows the reader's light or
dark system theme.

### `annotate`

This is the "add comments into the code" half. It is idempotent and safe to run
repeatedly — it only ever adds what is missing.

```bash
# See what it would do
node dist/apexdoc.js annotate force-app --dry-run

# Do it, keeping .bak copies
node dist/apexdoc.js annotate force-app --backup
```

Given:

```apex
public class OrderCalculator {
    private static final Decimal VAT_RATE = 0.20;

    /**
     * Totals one order, VAT included.
     *
     * @param orderId Order to total.
     */
    public Decimal total(Id orderId, Boolean includeVat) { ... }
}
```

it produces:

```apex
/**
 * @description TODO: describe OrderCalculator.
 * @group TODO
 * @author TODO
 * @version 2026-08-15
 */
public class OrderCalculator {
    /** @description TODO: describe VAT_RATE. */
    private static final Decimal VAT_RATE = 0.20;

    /**
     * Totals one order, VAT included.
     *
     * @param orderId Order to total.
     * @param includeVat TODO
     * @return TODO
     */
    public Decimal total(Id orderId, Boolean includeVat) { ... }
}
```

Summaries are written as an explicit `@description` rather than as bare leading
prose. Both parse — but the tag is unambiguous for any tool reading the comment
back, and it is the convention Salesforce's own Apex follows.

#### File header template

A **top-level** type gets a file header rather than the plain stub. The
built-in template is:

```
/**
 * @description {{description}}
 * @group {{group}}
 * @author {{author}}
 * @version {{version}}
 */
```

```bash
node dist/apexdoc.js annotate SOQLRecipes.cls \
  --author "Justin Jang" --group "Data Recipes"
```

```apex
/**
 * @description TODO: describe SOQLRecipes.
 * @group Data Recipes
 * @author Justin Jang
 * @version 2026-08-15
 */
public with sharing class SOQLRecipes {
```

`--author` and `--group` default to the `--placeholder` text and
`--doc-version` to today's date, so the header is useful even with no flags at
all. `@group` is worth filling in: it is what organises the overview page.

Supply your own layout with `--header <file>` — the file holds the whole comment
block, `/**` and `*/` included:

```bash
node dist/apexdoc.js annotate force-app --header templates/header.txt --author "Justin Jang"
```

| Placeholder | Expands to |
| --- | --- |
| `{{description}}` | `TODO: describe <Name>.` — the generated summary line |
| `{{name}}` / `{{qualifiedName}}` | `Temperature` / `Outer.Inner` |
| `{{kind}}` | `class`, `interface` or `enum` |
| `{{file}}` | Path of the source file |
| `{{author}}` | `--author`, or the placeholder |
| `{{group}}` | `--group`, or the placeholder |
| `{{version}}` | `--doc-version`, or today's date |
| `{{date}}` / `{{dateLong}}` | `2026-08-15` / `August 15, 2026` |
| `{{year}}` | `2026` |
| `{{placeholder}}` | The `--placeholder` text |

An unrecognised `{{tag}}` is left in the output verbatim rather than blanked, so
a typo in a custom template is visible instead of silent.

Notes:

- Nested types keep the plain stub — the header is per file, not per class.
- Existing prose is never rewritten; only missing tags are appended.
- The file's line endings are preserved (CRLF stays CRLF).
- `annotate` documents everything by default, private members included. Pass
  `--access public` to restrict it.
- Enum constants are left alone, since several may share a line.
- A generated stub is inserted directly above the declaration, below any `//`
  comment that was already there.

### `check`

```bash
node dist/apexdoc.js check force-app --access public --strict
```

```
warn  OrderCalculator.cls:19  OrderCalculator.total: missing @param includeVat [missing-param]
warn  OrderCalculator.cls:19  OrderCalculator.total: missing @return (returns Decimal) [missing-return]

3 type(s) checked — 0 error(s), 9 warning(s)
Coverage  types 4/5 (80%)  members 16/22 (73%)
```

| Rule | Meaning |
| --- | --- |
| `missing-doc` | No doc comment at all |
| `empty-description` | Comment present, but says nothing |
| `missing-param` | A parameter has no `@param` |
| `unknown-param` | An `@param` matches no parameter |
| `missing-return` | Non-`void` method with no `@return` |
| `spurious-return` | `void` method with a `@return` |
| `parse-error` | The file did not parse cleanly (severity `error`) |

Exit code is 1 when a file fails to parse, or — with `--strict` — when any
warning is reported. Otherwise 0. That makes `check --strict` usable as a CI
gate; without `--strict` it only fails on Apex that will not parse.

## Supported tags

Both JavaDoc-style leading prose and the ApexDoc `@description` tag are
accepted, so either of these works:

```apex
/** Finds accounts by name. */
/** @description Finds accounts by name. */
```

`annotate` generates the tagged form. A `@description` may run over several
lines — every line up to the next tag belongs to it:

```apex
/**
 * @description Demonstrates how to make various types of SOQL calls
 * including multi-object queries, and aggregate queries
 * @group Data Recipes
 */
```

| Tag | Applies to |
| --- | --- |
| `@description` | everything (optional — leading prose works too) |
| `@param <name> <text>` | methods, constructors |
| `@return` / `@returns` | methods |
| `@throws` / `@exception` | methods, constructors |
| `@author`, `@date`, `@since`, `@version` | types |
| `@group`, `@group-content` | types — `@group` becomes the section in the overview |
| `@see` | everything |
| `@example` | everything — rendered as an Apex code block, indentation preserved |
| `@deprecated` | everything — renders a warning banner |

Inline `{@link SomeType}` becomes a cross-reference when the type is part of
the same run, and inline `` `code` `` is rendered as code.

Descriptions are treated as light Markdown: a blank line starts a new
paragraph, and a line beginning with `*` or `-` starts a bullet, which may wrap
onto indented continuation lines.

```apex
/**
 * @description Groups records by a field value.
 *
 * Two rules keep the result predictable:
 *
 * * A record whose field is null lands under a null key rather than
 *   being dropped.
 * * Keys compare with `equals`, so Id and Decimal fields behave.
 *
 * @example
 * ```
 * Map<String, List<SObject>> byAccount =
 *     SObjectGrouper.groupByField('AccountId', contacts);
 * ```
 */
```

Wrapping an `@example` in a Markdown code fence is optional — the fence is
stripped, since the renderers add their own. Tag bodies that wrap across
several source lines are folded back onto one line where the output needs it,
such as inside a Markdown list item.

Unrecognised tags are kept in the model (`unknownTags`) rather than dropped, so
nothing you write is silently lost.

## Using it as a library

Everything the CLI does is available programmatically from
`dist/apexdoc/index.js`:

```ts
import {
    loadProject,
    filterByVisibility,
    validateProject,
    renderHtml,
    annotateSource,
} from './dist/apexdoc/index.js';

const project = filterByVisibility(loadProject(['force-app'], 'My Org'), 'public');
const validation = validateProject(project);

for (const page of renderHtml(project, validation)) {
    console.log(page.fileName, page.content.length);
}
```

`parseApexSource(source, path)` gives you the raw model for a single file if you
want to build something else on top of it. Type declarations are emitted
alongside the JavaScript, so the API is typed for TypeScript consumers.

## How doc comments are bound to declarations

Comments are read from the lexer's hidden comment channel and attached by token
adjacency: a `/** */` block binds to the declaration that follows it only when
nothing but whitespace and ordinary comments sits in between. That is why a
class-level comment never leaks onto the first member — the `class` keyword and
`{` stop the search. Line-offset heuristics get this wrong; token adjacency does
not.

## Not covered

- `.trigger` files. The parser supports them through a separate entry rule; the
  generator does not use it yet.
- Inheritance. Members are not pulled up from a superclass or interface into the
  implementing type's page.
- Cross-org links, versioned diffs, or a search index beyond the sidebar filter.
