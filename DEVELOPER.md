# Developer guide

How to build, run, test and extend `apexdoc`. For using the tool, see
[README.md](README.md).

## Toolchain

| | |
| --- | --- |
| Runtime | Node.js **22 or newer** (`node --version`) |
| Language | TypeScript 5.9, compiled with `tsc` — no bundler, no loader, no transpiler at runtime |
| Module format | ESM (`"type": "module"` in `package.json`) |
| Parser | `@apexdevtools/apex-parser` 4.4 on top of `antlr4ts` |
| Tests | Node's built-in runner (`node --test`) — nothing extra to install |

There is no webpack/esbuild/rollup step and no `ts-node`. The only build is
`tsc`, and the thing you run is the plain JavaScript it emits.

## Generating the JavaScript

This is the whole build:

```bash
npm install        # once
npm run build      # == tsc
```

`tsc` reads [tsconfig.json](tsconfig.json), compiles everything under `src/`
and writes the result to `dist/`, mirroring the directory structure:

| Source | Emitted |
| --- | --- |
| `src/apexdoc.ts` | `dist/apexdoc.js` — the executable entry point |
| `src/apexdoc/*.ts` | `dist/apexdoc/*.js` + `*.d.ts` |
| `src/test/apexdoc.test.ts` | `dist/test/apexdoc.test.js` |

Everyday commands:

```bash
npm run build       # one-off compile
npm run watch       # tsc --watch: recompile on save
npm run typecheck   # tsc --noEmit: type errors only, emits nothing
npm run clean       # delete dist/
npm run rebuild     # clean + build, when you want to be sure
```

`npm run build` prints nothing on success. If it prints, it failed.

### Building from absolute scratch

If you ever need to recreate the project skeleton:

```bash
mkdir apex-doc && cd apex-doc
npm init -y
npm install --save-dev typescript @types/node
npm install @apexdevtools/apex-parser antlr4ts
npx tsc --init
```

Then set `"type": "module"` in `package.json` and use the `compilerOptions`
below.

### tsconfig options that matter

```jsonc
{
  "target": "ES2022",              // Node 22 supports everything ES2022 emits
  "module": "ES2022",              // ESM out, matching "type": "module"
  "moduleResolution": "bundler",   // lets TS resolve without extensions...
  "outDir": "./dist",
  "rootDir": "./src",              // ...so dist/ mirrors src/ exactly
  "declaration": true,             // emits .d.ts so the package is usable as a library
  "strict": true,
  "esModuleInterop": true,
  "skipLibCheck": true             // antlr4ts ships loose typings; don't check them
}
```

`rootDir` is what keeps `dist/` a clean mirror of `src/`. Drop it and TypeScript
picks the common ancestor of the inputs, and paths shift the moment you add a
file outside `src/`.

## Running the built tool

```bash
node dist/apexdoc.js --help
node dist/apexdoc.js generate examples -o apexdocs -t "Apex Demo"
node dist/apexdoc.js check examples --access private
node dist/apexdoc.js annotate examples/OrderCalculator.cls --dry-run
```

Or through npm, which builds first:

```bash
npm run docs      # build + generate docs for examples/
npm run check     # build + check examples/ at --access private
npm run apexdoc -- generate examples --format json   # note the --
```

The `--` in `npm run apexdoc -- …` is required: without it npm swallows the
flags instead of passing them to the script.

### Installing the CLI globally

`package.json` declares `"bin": { "apexdoc": "dist/apexdoc.js" }`, and
`src/apexdoc.ts` starts with a `#!/usr/bin/env node` shebang that `tsc` copies
through. So after a build:

```bash
npm run build
npm link            # from the project root
apexdoc generate force-app -o docs
```

`npm unlink -g apex-doc` removes it. On Windows `npm link` writes an
`apexdoc.cmd` shim into the global prefix; make sure that directory is on
`PATH` (`npm prefix -g`).

Remember to re-run `npm run build` after changing any TypeScript — the linked
command runs `dist/`, not `src/`.

## Tests

```bash
npm test            # build, then node --test "dist/test/*.test.js"
```

To run the suite without rebuilding, or to focus on one test:

```bash
node --test "dist/test/*.test.js"
node --test --test-name-pattern "generic" "dist/test/*.test.js"
```

Tests are written in TypeScript in `src/test/` and run as compiled JavaScript
from `dist/test/`. That means **a stale build runs stale tests** — when a change
seems to have no effect, rebuild.

The suite covers the parser (nested generics, modifiers, initializers, error
recovery), doc-comment binding, the validator, `annotate` (idempotence, CRLF,
visibility floor) and both renderers (anchor integrity, HTML escaping).

## Continuous integration

[`.github/workflows/security-audit.yml`](.github/workflows/security-audit.yml)
runs `npm ci` followed by `npm audit --audit-level=high` on every push and pull
request to `main`, every Monday at 06:00 UTC, and on demand via
**Actions → Security audit → Run workflow**.

The weekly run is the point of the whole thing: a push-triggered audit only ever
tells you about advisories that existed the last time the tree changed. Most
CVEs land against dependencies that have been sitting untouched for months, and
the schedule is what surfaces those. Note that scheduled workflows only fire on
the default branch.

`--audit-level=high` sets the *exit code* threshold only — the full report is
printed regardless, so moderate and low advisories still appear in the log and
in the run summary without turning the badge red. Tighten it to `moderate` in
the workflow if you want a stricter gate.

Reproduce it locally with:

```bash
npm ci                            # exact tree from the lockfile
npm audit --audit-level=high
npm audit fix                     # patch/minor bumps only
npm audit fix --dry-run           # see what it would do first
```

`npm audit fix --force` is the one to avoid unless you mean it: it accepts
major-version bumps and can break the build to close an advisory.

This is also where the committed lockfile earns its keep — `npm audit` and
`npm ci` both require it, and `npm ci` fails loudly if `package.json` and
`package-lock.json` have drifted apart.

## Source layout

```
src/
  apexdoc.ts              executable entry point (shebang + process.exitCode)
  apexdoc/
    model.ts              the data model shared by every stage
    doc-comment.ts        /** ... */ tag parser
    extractor.ts          Apex source -> model
    project.ts            file discovery, loading, visibility filtering
    validate.ts           consistency rules and coverage
    render-shared.ts      helpers common to both renderers
    render-markdown.ts    Markdown output
    render-html.ts        JavaDoc-style HTML site
    annotate.ts           writes comments back into the source
    cli.ts                argument parsing and commands
    index.ts              public API surface
  test/apexdoc.test.ts    test suite
examples/                 sample Apex, including a deliberately undocumented class
```

### The pipeline

```
.cls files
    │  project.ts      findApexFiles → loadProject
    ▼
extractor.ts           ANTLR parse + doc-comment binding
    │
    ▼
model.ts (Project)     plain data — no ANTLR types past this line
    │
    ├─► validate.ts    issues + coverage
    ├─► render-html.ts / render-markdown.ts → Page[]
    └─► annotate.ts    line edits back onto the original source
```

`model.ts` is the contract. Renderers never touch an ANTLR context, so a change
to the grammar or the parser version can only ever break `extractor.ts`.

## Extending it

**Add a doc tag.** Add the field to `ApexDoc` in `model.ts`, add a `case` in
`saveTag`'s switch in `doc-comment.ts`, add it to `KNOWN_TAGS`, then surface it
in `typeMetadata`/`memberDetail` in each renderer. Skip the last step and the
tag still parses — it just does not appear in the output. `@version` is the
worked example: four small edits across those four files.

**Change the generated file header.** `DEFAULT_HEADER_TEMPLATE` in
`annotate.ts` holds the built-in block, and `renderHeader` builds the
placeholder map that fills it. Adding a placeholder means one entry in that
`values` record — the substitution and the leave-unknown-tags-alone behaviour
come for free. A template is only ever applied to a type with `isInner === false`.

**Add a validation rule.** Add a `this.add(...)` call in `Validator.checkMember`
or `checkType` in `validate.ts` with a new `rule` slug, and list it in the
README's rule table.

**Add an output format.** Write a module exporting
`render<Format>(project): Page[]`, then add the format to the `Format` union,
`parseFormats` and the `runGenerate` switch in `cli.ts`.

**Support `.trigger` files.** The parser exposes a separate `triggerUnit()`
entry rule (see `TriggerUnitContext` in the parser's `.d.ts`). You would add a
`parseTriggerSource` next to `parseApexSource`, a `TriggerInfo` variant in the
model, and `.trigger` to `APEX_EXTENSIONS` in `project.ts`.

## Gotchas

**Relative imports need the `.js` extension.** `moduleResolution: "bundler"`
lets TypeScript resolve `./model` without one, but the emitted ESM is run
directly by Node, which does not guess extensions. Always write
`import … from './model.js'` in a `.ts` file. The failure is at runtime, not
compile time: `tsc` stays silent and the import throws `ERR_MODULE_NOT_FOUND`
the first time you run the build.

**`COMMENT_CHANNEL` is 3, not 2.** In this parser build, channel 2 is
whitespace and 3 carries comments; the doc-comment token type is
`ApexLexer.DOC_COMMENT` (249). Both are referenced by name in `extractor.ts` —
do not hard-code the numbers.

**`ctx.text` drops whitespace.** ANTLR's `getText()` concatenates token texts,
so `new List<Account>()` comes back as `newList<Account>()`. `extractor.ts`
uses `sourceText()`, which slices the original input stream by character
interval, for anything a human reads.

**Line endings.** `annotate.ts` detects CRLF vs LF from the file it is about to
rewrite and re-joins with the same ending. Anything else touching source text
must do the same, or every line of every annotated file shows up in the diff.

**Rebuild before you test.** See the Tests section — `npm test` does it for you,
`node --test` on its own does not.

## Packaging

```bash
npm run rebuild
npm pack            # produces apex-doc-1.0.0.tgz containing only dist/
```

The `files` field narrows the tarball to `dist/apexdoc.js` and `dist/apexdoc/`,
so the compiled tests stay out of it; `main`, `types` and `bin` all point inside
that set. npm adds `package.json`, `README.md` and `LICENSE.txt` on its own
regardless. `npm pack --dry-run` lists what would ship without writing the
tarball.
