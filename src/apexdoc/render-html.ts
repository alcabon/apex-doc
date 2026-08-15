/**
 * JavaDoc-style HTML renderer.
 *
 * Produces a small static site: an overview page, one page per top-level type,
 * and a shared stylesheet. The layout follows JavaDoc's — a persistent type
 * list on the left, summary tables above detail sections on the right — so the
 * output is navigable without a server.
 */

import { INLINE_LINK_RE } from './doc-comment.js';
import type {
    ApexDoc,
    ClassInfo,
    ConstructorInfo,
    Documentable,
    EnumInfo,
    FieldInfo,
    MethodInfo,
    Project,
    PropertyInfo,
    TypeDeclaration,
} from './model.js';
import { declarationOf, firstSentence, formatParams, walkTypes } from './model.js';
import type { Page } from './render-shared.js';
import {
    escapeHtml,
    groupUnknownTags,
    groupsOf,
    modifierColumn,
    slugify,
    tagLabel,
    typeLabel,
} from './render-shared.js';
import type { ValidationResult } from './validate.js';
import { formatRatio } from './validate.js';

const APEX_KEYWORDS = new Set([
    'abstract', 'class', 'enum', 'extends', 'final', 'global', 'implements', 'inherited',
    'interface', 'override', 'private', 'protected', 'public', 'sharing', 'static',
    'testmethod', 'transient', 'virtual', 'void', 'webservice', 'with', 'without', 'get', 'set',
]);

interface Context {
    /** Every documented type, by simple name, for `{@link}` resolution. */
    known: Map<string, TypeDeclaration>;
    /** The sidebar, identical on every page. */
    sidebar: string;
    title: string;
}

/** Renders the whole project as a static HTML site. */
export function renderHtml(project: Project, validation?: ValidationResult): Page[] {
    const known = new Map(project.types.flatMap((t) => walkTypes(t)).map((t) => [t.name, t]));
    const ctx: Context = { known, sidebar: sidebar(project), title: project.title };

    return [
        { fileName: 'styles.css', content: STYLESHEET },
        { fileName: 'index.html', content: renderOverview(project, ctx, validation) },
        ...project.types.map((decl) => ({
            fileName: `${decl.name}.html`,
            content: renderTypePage(decl, ctx),
        })),
    ];
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function page(ctx: Context, pageTitle: string, main: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)} — ${escapeHtml(ctx.title)}</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="index.html">${escapeHtml(ctx.title)}</a>
  <span class="crumb">${escapeHtml(pageTitle)}</span>
</header>
<div class="layout">
  <aside class="sidebar">
    <input type="search" id="type-filter" placeholder="Filter types…" aria-label="Filter types">
    ${ctx.sidebar}
  </aside>
  <main>
${main}
  </main>
</div>
<script>
(function () {
  var input = document.getElementById('type-filter');
  if (!input) return;
  var groups = Array.prototype.slice.call(document.querySelectorAll('.sidebar .type-group'));
  input.addEventListener('input', function () {
    var needle = input.value.toLowerCase();
    groups.forEach(function (group) {
      var visible = 0;
      Array.prototype.forEach.call(group.querySelectorAll('li'), function (item) {
        var match = item.textContent.toLowerCase().indexOf(needle) !== -1;
        item.hidden = !match;
        if (match) visible++;
      });
      group.hidden = visible === 0;
    });
  });
})();
</script>
</body>
</html>
`;
}

function sidebar(project: Project): string {
    const sections = groupsOf(project.types).map(([group, types]) => {
        const items = types
            .map(
                (decl) =>
                    `<li><a href="${decl.name}.html"><span class="kind kind-${decl.kind}">${decl.kind[0].toUpperCase()}</span>${escapeHtml(decl.name)}</a></li>`,
            )
            .join('\n        ');
        return `    <section class="type-group">
      <h2>${escapeHtml(group)}</h2>
      <ul>
        ${items}
      </ul>
    </section>`;
    });
    return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function renderOverview(project: Project, ctx: Context, validation?: ValidationResult): string {
    const out: string[] = [`<h1>${escapeHtml(project.title)}</h1>`];

    const stats: string[] = [
        stat('Types', String(project.types.length)),
        stat('Files', String(project.files.length)),
    ];
    if (validation) {
        stats.push(
            stat(
                'Documented types',
                formatRatio(validation.coverage.types.documented, validation.coverage.types.total),
            ),
            stat(
                'Documented members',
                formatRatio(
                    validation.coverage.members.documented,
                    validation.coverage.members.total,
                ),
            ),
        );
    }
    out.push(`<div class="stats">${stats.join('')}</div>`);

    for (const [group, types] of groupsOf(project.types)) {
        out.push(`<h2 class="group-heading">${escapeHtml(group)}</h2>`);
        out.push('<table class="summary">');
        out.push('<thead><tr><th scope="col">Type</th><th scope="col">Description</th></tr></thead>');
        out.push('<tbody>');
        for (const decl of types) {
            out.push(
                `<tr><th scope="row"><a href="${decl.name}.html">${escapeHtml(typeLabel(decl))}</a></th>` +
                    `<td>${inline(firstSentence(decl.doc?.description), ctx)}</td></tr>`,
            );
        }
        out.push('</tbody></table>');
    }

    return page(ctx, 'Overview', out.join('\n'));
}

function stat(label: string, value: string): string {
    return `<div class="stat"><span class="stat-value">${escapeHtml(value)}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Type page
// ---------------------------------------------------------------------------

function renderTypePage(decl: TypeDeclaration, ctx: Context): string {
    const out: string[] = [];
    out.push(...renderType(decl, ctx, 1));

    const nested = decl.kind === 'class' ? decl.innerTypes : [];
    if (nested.length > 0) {
        out.push('<h2 class="section">Nested Type Summary</h2>');
        out.push('<table class="summary">');
        out.push('<thead><tr><th scope="col">Type</th><th scope="col">Description</th></tr></thead><tbody>');
        for (const inner of nested) {
            out.push(
                `<tr><th scope="row"><a href="#${anchorOfType(inner)}">${escapeHtml(typeLabel(inner))}</a></th>` +
                    `<td>${inline(firstSentence(inner.doc?.description), ctx)}</td></tr>`,
            );
        }
        out.push('</tbody></table>');

        for (const inner of nested) {
            out.push(`<section class="nested" id="${anchorOfType(inner)}">`);
            out.push(...renderType(inner, ctx, 2));
            out.push('</section>');
        }
    }

    return page(ctx, decl.name, out.join('\n'));
}

/** Header, description, metadata and members of one type. */
function renderType(decl: TypeDeclaration, ctx: Context, level: number): string[] {
    const h = `h${level}`;
    const out: string[] = [];

    out.push(`<${h} class="type-title"><span class="kind-word">${decl.kind}</span> ${escapeHtml(decl.qualifiedName)}</${h}>`);
    out.push(signature(declarationOf(decl)));

    if (decl.doc?.deprecated) {
        out.push(`<div class="deprecated"><strong>Deprecated.</strong> ${inline(decl.doc.deprecated, ctx)}</div>`);
    }
    if (decl.doc?.description) out.push(paragraphs(decl.doc.description, ctx));

    out.push(typeMetadata(decl, ctx));
    out.push(...members(decl, ctx, level + 1));
    return out;
}

function typeMetadata(decl: TypeDeclaration, ctx: Context): string {
    const rows: Array<[string, string]> = [];

    if (decl.kind === 'class' && decl.extends) rows.push(['Extends', typeRefs([decl.extends], ctx)]);
    if (decl.kind === 'class' && decl.implements.length > 0) {
        rows.push(['Implements', typeRefs(decl.implements, ctx)]);
    }
    if (decl.kind === 'interface' && decl.extends.length > 0) {
        rows.push(['Extends', typeRefs(decl.extends, ctx)]);
    }
    if (decl.doc?.author) rows.push(['Author', escapeHtml(decl.doc.author)]);
    if (decl.doc?.date) rows.push(['Date', escapeHtml(decl.doc.date)]);
    if (decl.doc?.since) rows.push(['Since', escapeHtml(decl.doc.since)]);
    if (decl.doc?.version) rows.push(['Version', escapeHtml(decl.doc.version)]);
    if (decl.doc?.group) rows.push(['Group', escapeHtml(decl.doc.group)]);
    if (decl.doc?.see.length) rows.push(['See also', typeRefs(decl.doc.see, ctx)]);
    rows.push(...customTagRows(decl.doc, ctx));
    rows.push(['Source', `<code>${escapeHtml(decl.file)}</code> line ${decl.anchorLine}`]);

    return definitionList(rows);
}

function members(decl: TypeDeclaration, ctx: Context, level: number): string[] {
    if (decl.kind === 'enum') return enumMembers(decl, ctx);
    if (decl.kind === 'interface') {
        return [
            ...methodSummary(decl.methods, ctx, level),
            ...methodDetail(decl.methods, ctx, level),
        ];
    }
    return classMembers(decl, ctx, level);
}

function enumMembers(decl: EnumInfo, ctx: Context): string[] {
    if (decl.constants.length === 0) return [];
    const rows = decl.constants
        .map(
            (constant) =>
                `<tr><th scope="row"><code>${escapeHtml(constant.name)}</code></th>` +
                `<td>${inline(constant.doc?.description ?? '', ctx)}</td></tr>`,
        )
        .join('\n');
    return [
        '<h3 class="section">Enum Constants</h3>',
        '<table class="summary">',
        '<thead><tr><th scope="col">Constant</th><th scope="col">Description</th></tr></thead>',
        `<tbody>${rows}</tbody></table>`,
    ];
}

function classMembers(decl: ClassInfo, ctx: Context, level: number): string[] {
    const out: string[] = [];
    const h = `h${Math.min(level, 6)}`;

    if (decl.constructors.length > 0) {
        out.push(`<${h} class="section">Constructor Summary</${h}>`);
        out.push(
            summaryTable(
                ['Constructor', 'Description'],
                decl.constructors.map((ctor) => [
                    `<a href="#${anchorOfMember(decl, ctor)}"><code>${escapeHtml(signatureLabel(ctor))}</code></a>`,
                    inline(firstSentence(ctor.doc?.description), ctx),
                ]),
            ),
        );
    }

    if (decl.fields.length > 0) {
        out.push(`<${h} class="section">Field Summary</${h}>`);
        out.push(
            summaryTable(
                ['Modifier and Type', 'Field', 'Description'],
                decl.fields.map((field) => [
                    `<code class="modifiers">${escapeHtml(modifierColumn(field))}</code> <code>${escapeHtml(field.type)}</code>`,
                    `<code>${escapeHtml(field.name)}</code>`,
                    fieldDescription(field, ctx),
                ]),
            ),
        );
    }

    if (decl.properties.length > 0) {
        out.push(`<${h} class="section">Property Summary</${h}>`);
        out.push(
            summaryTable(
                ['Modifier and Type', 'Property', 'Accessors', 'Description'],
                decl.properties.map((property) => [
                    `<code class="modifiers">${escapeHtml(modifierColumn(property))}</code> <code>${escapeHtml(property.type)}</code>`,
                    `<code>${escapeHtml(property.name)}</code>`,
                    accessors(property),
                    inline(firstSentence(property.doc?.description), ctx),
                ]),
            ),
        );
    }

    out.push(...methodSummary(decl.methods, ctx, level, decl));

    if (decl.constructors.length > 0) {
        out.push(`<${h} class="section">Constructor Detail</${h}>`);
        out.push(...decl.constructors.map((ctor) => memberDetail(decl, ctor, ctx)));
    }

    out.push(...methodDetail(decl.methods, ctx, level, decl));
    return out;
}

function methodSummary(
    methods: MethodInfo[],
    ctx: Context,
    level: number,
    owner?: TypeDeclaration,
): string[] {
    if (methods.length === 0) return [];
    const h = `h${Math.min(level, 6)}`;
    return [
        `<${h} class="section">Method Summary</${h}>`,
        summaryTable(
            ['Modifier and Type', 'Method', 'Description'],
            methods.map((method) => [
                `<code class="modifiers">${escapeHtml(modifierColumn(method))}</code> <code>${escapeHtml(method.returnType)}</code>`,
                owner
                    ? `<a href="#${anchorOfMember(owner, method)}"><code>${escapeHtml(signatureLabel(method))}</code></a>`
                    : `<code>${escapeHtml(signatureLabel(method))}</code>`,
                inline(firstSentence(method.doc?.description), ctx),
            ]),
        ),
    ];
}

function methodDetail(
    methods: MethodInfo[],
    ctx: Context,
    level: number,
    owner?: TypeDeclaration,
): string[] {
    if (methods.length === 0) return [];
    const h = `h${Math.min(level, 6)}`;
    return [
        `<${h} class="section">Method Detail</${h}>`,
        ...methods.map((method) => memberDetail(owner, method, ctx)),
    ];
}

function memberDetail(
    owner: TypeDeclaration | undefined,
    member: ConstructorInfo | MethodInfo,
    ctx: Context,
): string {
    const id = owner ? ` id="${anchorOfMember(owner, member)}"` : '';
    const out: string[] = [`<section class="member"${id}>`];
    out.push(`<h4 class="member-title">${escapeHtml(signatureLabel(member))}</h4>`);
    out.push(signature(declarationOf(member)));

    const doc = member.doc;
    if (doc?.deprecated) {
        out.push(`<div class="deprecated"><strong>Deprecated.</strong> ${inline(doc.deprecated, ctx)}</div>`);
    }
    if (doc?.description) out.push(paragraphs(doc.description, ctx));
    if (!doc) out.push('<p class="undocumented">No documentation available.</p>');

    const rows: Array<[string, string]> = [];

    if (member.parameters.length > 0) {
        const items = member.parameters
            .map((param) => {
                const text = doc?.params.find((p) => p.name === param.name)?.description;
                return `<li><code class="param-name">${escapeHtml(param.name)}</code> <code class="param-type">${escapeHtml(param.type)}</code>${
                    text ? ` — ${inline(text, ctx)}` : ''
                }</li>`;
            })
            .join('');
        rows.push(['Parameters', `<ul class="params">${items}</ul>`]);
    }

    if (doc?.returns) rows.push(['Returns', inline(doc.returns, ctx)]);

    if (doc?.throws.length) {
        const items = doc.throws
            .map(
                (thrown) =>
                    `<li>${typeRefs([thrown.type], ctx)}${thrown.description ? ` — ${inline(thrown.description, ctx)}` : ''}</li>`,
            )
            .join('');
        rows.push(['Throws', `<ul class="params">${items}</ul>`]);
    }

    if (doc?.example) {
        rows.push(['Example', `<pre class="example"><code>${escapeHtml(doc.example)}</code></pre>`]);
    }
    if (doc?.see.length) rows.push(['See also', typeRefs(doc.see, ctx)]);
    rows.push(...customTagRows(doc, ctx));

    out.push(definitionList(rows));
    out.push('</section>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function summaryTable(headers: string[], rows: string[][]): string {
    const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('');
    const body = rows
        .map((cells) => {
            const [first, ...rest] = cells;
            return `<tr><th scope="row">${first}</th>${rest.map((c) => `<td>${c}</td>`).join('')}</tr>`;
        })
        .join('\n');
    return `<table class="summary"><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

/** One row per custom tag; repeated tags become a list under one heading. */
function customTagRows(doc: ApexDoc | undefined, ctx: Context): Array<[string, string]> {
    return groupUnknownTags(doc).map(([tag, values]) => {
        if (values.length === 1) return [tagLabel(tag), inline(values[0], ctx)] as [string, string];
        const items = values.map((value) => `<li>${inline(value, ctx)}</li>`).join('');
        return [tagLabel(tag), `<ul class="params">${items}</ul>`] as [string, string];
    });
}

function definitionList(rows: Array<[string, string]>): string {
    if (rows.length === 0) return '';
    const items = rows
        .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${value}</dd>`)
        .join('\n');
    return `<dl class="tags">\n${items}\n</dl>`;
}

/** A declaration rendered as highlighted Apex. */
function signature(text: string): string {
    return `<pre class="signature"><code>${highlight(text)}</code></pre>`;
}

/** Minimal Apex highlighting: annotations, keywords and type names. */
function highlight(text: string): string {
    return escapeHtml(text).replace(/@?[A-Za-z_][\w.]*/g, (token) => {
        if (token.startsWith('@')) return `<span class="tok-annotation">${token}</span>`;
        if (APEX_KEYWORDS.has(token.toLowerCase())) return `<span class="tok-keyword">${token}</span>`;
        if (/^[A-Z]/.test(token)) return `<span class="tok-type">${token}</span>`;
        return token;
    });
}

function accessors(property: PropertyInfo): string {
    const parts = [property.hasGetter ? 'get' : null, property.hasSetter ? 'set' : null].filter(Boolean);
    return parts.map((p) => `<code>${p}</code>`).join(' ');
}

function fieldDescription(field: FieldInfo, ctx: Context): string {
    const summary = inline(firstSentence(field.doc?.description), ctx);
    if (!field.initializer) return summary;
    const initial = `<span class="initial">Default: <code>${escapeHtml(field.initializer)}</code></span>`;
    return summary ? `${summary} ${initial}` : initial;
}

function signatureLabel(member: ConstructorInfo | MethodInfo): string {
    return `${member.name}(${formatParams(member.parameters)})`;
}

function anchorOfType(decl: TypeDeclaration): string {
    return slugify(`type-${decl.qualifiedName}`);
}

function anchorOfMember(owner: TypeDeclaration, member: Documentable): string {
    const params =
        'parameters' in member && Array.isArray(member.parameters)
            ? member.parameters.map((p) => p.type).join('-')
            : '';
    return slugify(`${owner.qualifiedName}-${member.kind}-${member.name}-${params}`);
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

/**
 * Turns a description into paragraphs and lists.
 *
 * Doc comments are written as light Markdown: blank lines separate paragraphs,
 * and `*` or `-` at the start of a line begins a bullet. A wrapped bullet is
 * indented on its continuation lines, which is how those are told apart from
 * the start of a new paragraph.
 */
function paragraphs(text: string, ctx: Context): string {
    const out: string[] = [];
    let prose: string[] = [];
    let items: string[] = [];

    const flushProse = (): void => {
        if (prose.length === 0) return;
        out.push(`<p>${inline(prose.join(' '), ctx)}</p>`);
        prose = [];
    };

    const flushList = (): void => {
        if (items.length === 0) return;
        const rendered = items.map((item) => `<li>${inline(item, ctx)}</li>`).join('');
        out.push(`<ul class="doc-list">${rendered}</ul>`);
        items = [];
    };

    for (const line of text.split('\n')) {
        if (!line.trim()) {
            flushProse();
            flushList();
            continue;
        }

        const bullet = line.match(/^\s*[*-]\s+(.*)$/);
        if (bullet) {
            flushProse();
            items.push(bullet[1]);
            continue;
        }

        // Indented under an open bullet: a wrapped continuation of that item.
        if (items.length > 0 && /^\s/.test(line)) {
            items[items.length - 1] += ` ${line.trim()}`;
            continue;
        }

        flushList();
        prose.push(line.trim());
    }

    flushProse();
    flushList();
    return out.join('\n');
}

/**
 * Escapes a fragment and expands the two inline forms doc comments use:
 * `` `code` `` and `{@link Type}`.
 */
function inline(text: string, ctx: Context): string {
    if (!text) return '';
    return escapeHtml(text)
        .replace(INLINE_LINK_RE, (_all, target: string) => typeRefs([target.trim()], ctx, true))
        .replace(/`([^`]+)`/g, (_all, code: string) => `<code>${code}</code>`)
        .replace(/\n/g, ' ');
}

/**
 * Renders type references, linking the ones this project documents.
 * `preEscaped` is set when the caller already escaped the text.
 */
function typeRefs(targets: string[], ctx: Context, preEscaped = false): string {
    return targets
        .map((target) => {
            const label = preEscaped ? target : escapeHtml(target);
            const simpleName = target.split(/[.#\s(&]/)[0];
            const decl = ctx.known.get(simpleName);
            if (!decl) return `<code>${label}</code>`;
            const root = decl.qualifiedName.split('.')[0];
            const fragment = decl.isInner ? `#${anchorOfType(decl)}` : '';
            return `<a href="${root}.html${fragment}"><code>${label}</code></a>`;
        })
        .join(', ');
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

const STYLESHEET = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-alt: #f6f7f9;
  --bg-code: #f2f4f7;
  --border: #d9dde3;
  --text: #1c1f24;
  --text-muted: #5b636e;
  --accent: #1a5fb4;
  --accent-soft: #e8f0fb;
  --warn-bg: #fff4e5;
  --warn-border: #e5a24a;
  --kw: #8250df;
  --type: #0b6b63;
  --annotation: #a15c00;
  --radius: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c;
    --bg-alt: #1b1f26;
    --bg-code: #1f242c;
    --border: #2c323b;
    --text: #e6e9ee;
    --text-muted: #9aa4b1;
    --accent: #79b8ff;
    --accent-soft: #1d2937;
    --warn-bg: #33260f;
    --warn-border: #b4801f;
    --kw: #d2a8ff;
    --type: #57c7bb;
    --annotation: #e3b341;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

code, pre, .modifiers { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: baseline; gap: 12px;
  padding: 12px 20px;
  background: var(--bg-alt);
  border-bottom: 1px solid var(--border);
}
.brand { font-weight: 600; font-size: 16px; }
.crumb { color: var(--text-muted); font-size: 13px; }

.layout { display: flex; align-items: flex-start; }

.sidebar {
  position: sticky; top: 53px;
  flex: 0 0 260px;
  max-height: calc(100vh - 53px);
  overflow-y: auto;
  padding: 16px;
  border-right: 1px solid var(--border);
}
.sidebar input {
  width: 100%; padding: 6px 8px; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--text); font-size: 13px;
}
.sidebar h2 {
  margin: 14px 0 6px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--text-muted);
}
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li a { display: flex; gap: 8px; align-items: center; padding: 3px 0; font-size: 13.5px; }

.kind {
  flex: 0 0 18px; height: 18px; border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700;
  background: var(--accent-soft); color: var(--accent);
}
.kind-interface { background: var(--warn-bg); color: var(--warn-border); }
.kind-enum { background: var(--bg-code); color: var(--text-muted); }

main { flex: 1 1 auto; min-width: 0; padding: 24px 32px 96px; max-width: 1000px; }

h1, h2, h3, h4 { line-height: 1.25; }
h1 { font-size: 26px; margin: 8px 0 16px; }
.type-title .kind-word { color: var(--text-muted); font-weight: 400; }
.section {
  margin-top: 32px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border); font-size: 17px;
}
.member-title { margin: 24px 0 8px; font-size: 15px; }

.stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0 28px; }
.stat {
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 14px; min-width: 130px;
  background: var(--bg-alt); border: 1px solid var(--border); border-radius: var(--radius);
}
.stat-value { font-size: 18px; font-weight: 600; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }

table.summary {
  width: 100%; border-collapse: collapse; margin: 12px 0 8px;
  display: block; overflow-x: auto;
}
table.summary thead th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--text-muted); padding: 6px 10px; border-bottom: 1px solid var(--border);
}
table.summary tbody th, table.summary tbody td {
  text-align: left; font-weight: 400; vertical-align: top;
  padding: 8px 10px; border-bottom: 1px solid var(--border);
}
table.summary tbody tr:hover { background: var(--bg-alt); }
.modifiers { color: var(--text-muted); }
.initial { color: var(--text-muted); }

pre.signature, pre.example {
  background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 14px; overflow-x: auto; font-size: 13px; margin: 10px 0;
}
pre.signature { border-left: 3px solid var(--accent); }
:not(pre) > code { background: var(--bg-code); border-radius: 4px; padding: 1px 5px; font-size: 92%; }

.tok-keyword { color: var(--kw); }
.tok-type { color: var(--type); }
.tok-annotation { color: var(--annotation); }

dl.tags { margin: 12px 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dl.tags dt {
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--text-muted); padding-top: 3px;
}
dl.tags dd { margin: 0; min-width: 0; }
dl.tags dd pre { margin: 0; }
ul.params { list-style: none; margin: 0; padding: 0; }
ul.params li { padding: 2px 0; }
ul.doc-list { margin: 8px 0; padding-left: 22px; }
ul.doc-list li { padding: 2px 0; }
.param-name { font-weight: 600; }
.param-type { color: var(--text-muted); }

.deprecated {
  background: var(--warn-bg); border-left: 3px solid var(--warn-border);
  padding: 8px 12px; border-radius: 0 var(--radius) var(--radius) 0; margin: 12px 0;
}
.undocumented { color: var(--text-muted); font-style: italic; }

.member { padding-left: 14px; border-left: 2px solid var(--border); margin: 18px 0; }
.nested { margin-top: 40px; padding-top: 16px; border-top: 2px solid var(--border); }

@media (max-width: 800px) {
  .layout { flex-direction: column; }
  .sidebar { position: static; flex: 1 1 auto; width: 100%; max-height: none; border-right: 0; border-bottom: 1px solid var(--border); }
  main { padding: 20px 16px 64px; }
  dl.tags { grid-template-columns: 1fr; gap: 2px; }
  dl.tags dt { margin-top: 8px; }
}
`;
