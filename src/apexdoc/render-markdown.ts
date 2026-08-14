/**
 * Markdown renderer.
 *
 * Lays the pages out the way JavaDoc does — summary tables first, then the
 * detail sections — so the output reads the same whether you open it on disk,
 * in a wiki or on GitHub.
 */

import { INLINE_LINK_RE } from './doc-comment.js';
import type {
    ClassInfo,
    ConstructorInfo,
    EnumInfo,
    FieldInfo,
    MethodInfo,
    Project,
    TypeDeclaration,
} from './model.js';
import { declarationOf, firstSentence, formatParams, walkTypes } from './model.js';
import type { Page } from './render-shared.js';
import { groupsOf, modifierColumn, slugify, typeLabel } from './render-shared.js';

/** Renders the whole project as a set of Markdown pages. */
export function renderMarkdown(project: Project): Page[] {
    const known = new Map(project.types.flatMap((t) => walkTypes(t)).map((t) => [t.name, t]));
    const ctx: Context = { known };

    return [
        { fileName: 'README.md', content: renderIndex(project, ctx) },
        ...project.types.map((decl) => ({
            fileName: `${decl.name}.md`,
            content: renderType(decl, ctx),
        })),
    ];
}

interface Context {
    known: Map<string, TypeDeclaration>;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function renderIndex(project: Project, ctx: Context): string {
    const out: string[] = [`# ${project.title}`, ''];
    const groups = groupsOf(project.types);

    out.push(`${project.types.length} top-level type(s) in ${project.files.length} file(s).`, '');

    for (const [group, types] of groups) {
        out.push(`## ${group}`, '', '| Type | Description |', '| --- | --- |');
        for (const decl of types) {
            out.push(
                `| [${typeLabel(decl)}](${decl.name}.md) | ${cell(firstSentence(decl.doc?.description), ctx)} |`,
            );
        }
        out.push('');
    }

    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Type page
// ---------------------------------------------------------------------------

function renderType(decl: TypeDeclaration, ctx: Context): string {
    const out: string[] = [];
    out.push(`# ${typeLabel(decl)}`, '');
    out.push('```apex', declarationOf(decl), '```', '');

    if (decl.doc?.deprecated) {
        out.push(`> **Deprecated.** ${inline(decl.doc.deprecated, ctx)}`, '');
    }
    if (decl.doc?.description) {
        out.push(inline(decl.doc.description, ctx), '');
    }

    out.push(...typeMetadata(decl, ctx));
    out.push(...body(decl, ctx, 2));

    const nested = decl.kind === 'class' ? decl.innerTypes : [];
    if (nested.length > 0) {
        out.push('## Nested Type Summary', '', '| Type | Description |', '| --- | --- |');
        for (const inner of nested) {
            out.push(
                `| [${typeLabel(inner)}](#${slugify(typeLabel(inner))}) | ${cell(firstSentence(inner.doc?.description), ctx)} |`,
            );
        }
        out.push('');

        for (const inner of nested) {
            out.push(`## ${typeLabel(inner)}`, '');
            out.push('```apex', declarationOf(inner), '```', '');
            if (inner.doc?.description) out.push(inline(inner.doc.description, ctx), '');
            out.push(...typeMetadata(inner, ctx));
            out.push(...body(inner, ctx, 3));
        }
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function typeMetadata(decl: TypeDeclaration, ctx: Context): string[] {
    const out: string[] = [];
    const rows: string[] = [];

    if (decl.kind === 'class' && decl.extends) rows.push(`**Extends:** \`${decl.extends}\``);
    if (decl.kind === 'class' && decl.implements.length > 0) {
        rows.push(`**Implements:** ${decl.implements.map((t) => link(t, ctx)).join(', ')}`);
    }
    if (decl.kind === 'interface' && decl.extends.length > 0) {
        rows.push(`**Extends:** ${decl.extends.map((t) => link(t, ctx)).join(', ')}`);
    }
    if (decl.doc?.author) rows.push(`**Author:** ${decl.doc.author}`);
    if (decl.doc?.date) rows.push(`**Date:** ${decl.doc.date}`);
    if (decl.doc?.since) rows.push(`**Since:** ${decl.doc.since}`);
    if (decl.doc?.group) rows.push(`**Group:** ${decl.doc.group}`);
    if (decl.doc?.see.length) {
        rows.push(`**See also:** ${decl.doc.see.map((s) => link(s, ctx)).join(', ')}`);
    }
    rows.push(`**Source:** \`${decl.file}\` (line ${decl.anchorLine})`);

    if (rows.length > 0) out.push(rows.join('  \n'), '');
    return out;
}

function body(decl: TypeDeclaration, ctx: Context, level: number): string[] {
    if (decl.kind === 'enum') return enumBody(decl, ctx, level);
    if (decl.kind === 'interface') {
        return [
            ...methodSummary(decl.methods, ctx, level),
            ...methodDetail(decl.methods, ctx, level),
        ];
    }
    return classBody(decl, ctx, level);
}

function enumBody(decl: EnumInfo, ctx: Context, level: number): string[] {
    if (decl.constants.length === 0) return [];
    const h = '#'.repeat(level);
    const out = [`${h} Enum Constants`, '', '| Constant | Description |', '| --- | --- |'];
    for (const constant of decl.constants) {
        out.push(`| \`${constant.name}\` | ${cell(constant.doc?.description, ctx)} |`);
    }
    out.push('');
    return out;
}

function classBody(decl: ClassInfo, ctx: Context, level: number): string[] {
    const h = '#'.repeat(level);
    const out: string[] = [];

    if (decl.constructors.length > 0) {
        out.push(`${h} Constructor Summary`, '', '| Constructor | Description |', '| --- | --- |');
        for (const ctor of decl.constructors) {
            out.push(
                `| [\`${signatureLabel(ctor)}\`](#${slugify(signatureLabel(ctor))}) | ${cell(firstSentence(ctor.doc?.description), ctx)} |`,
            );
        }
        out.push('');
    }

    if (decl.fields.length > 0) {
        out.push(
            `${h} Field Summary`,
            '',
            '| Modifier and Type | Field | Description |',
            '| --- | --- | --- |',
        );
        for (const field of decl.fields) {
            out.push(
                `| \`${modifierColumn(field)} ${field.type}\` | \`${field.name}\` | ${cell(fieldSummary(field), ctx)} |`,
            );
        }
        out.push('');
    }

    if (decl.properties.length > 0) {
        out.push(
            `${h} Property Summary`,
            '',
            '| Modifier and Type | Property | Accessors | Description |',
            '| --- | --- | --- | --- |',
        );
        for (const property of decl.properties) {
            const accessors = [property.hasGetter ? 'get' : null, property.hasSetter ? 'set' : null]
                .filter(Boolean)
                .join(', ');
            out.push(
                `| \`${modifierColumn(property)} ${property.type}\` | \`${property.name}\` | ${accessors} | ${cell(firstSentence(property.doc?.description), ctx)} |`,
            );
        }
        out.push('');
    }

    out.push(...methodSummary(decl.methods, ctx, level));

    if (decl.constructors.length > 0) {
        out.push(`${h} Constructor Detail`, '');
        for (const ctor of decl.constructors) out.push(...memberDetail(ctor, ctx, level + 1));
    }

    out.push(...methodDetail(decl.methods, ctx, level));
    return out;
}

function methodSummary(methods: MethodInfo[], ctx: Context, level: number): string[] {
    if (methods.length === 0) return [];
    const out = [
        `${'#'.repeat(level)} Method Summary`,
        '',
        '| Modifier and Type | Method | Description |',
        '| --- | --- | --- |',
    ];
    for (const method of methods) {
        out.push(
            `| \`${modifierColumn(method)} ${method.returnType}\` | [\`${signatureLabel(method)}\`](#${slugify(signatureLabel(method))}) | ${cell(firstSentence(method.doc?.description), ctx)} |`,
        );
    }
    out.push('');
    return out;
}

function methodDetail(methods: MethodInfo[], ctx: Context, level: number): string[] {
    if (methods.length === 0) return [];
    const out = [`${'#'.repeat(level)} Method Detail`, ''];
    for (const method of methods) out.push(...memberDetail(method, ctx, level + 1));
    return out;
}

function memberDetail(
    member: ConstructorInfo | MethodInfo,
    ctx: Context,
    level: number,
): string[] {
    const out: string[] = [`${'#'.repeat(level)} ${signatureLabel(member)}`, ''];
    out.push('```apex', declarationOf(member), '```', '');

    const doc = member.doc;
    if (doc?.deprecated) out.push(`> **Deprecated.** ${inline(doc.deprecated, ctx)}`, '');
    if (doc?.description) out.push(inline(doc.description, ctx), '');

    if (member.parameters.length > 0) {
        out.push('**Parameters:**', '');
        for (const param of member.parameters) {
            const text = doc?.params.find((p) => p.name === param.name)?.description ?? '';
            out.push(`- \`${param.name}\` — \`${param.type}\`${text ? ` — ${inline(text, ctx)}` : ''}`);
        }
        out.push('');
    }

    if (doc?.returns) out.push(`**Returns:** ${inline(doc.returns, ctx)}`, '');

    if (doc?.throws.length) {
        out.push('**Throws:**', '');
        for (const thrown of doc.throws) {
            out.push(`- ${link(thrown.type, ctx)}${thrown.description ? ` — ${inline(thrown.description, ctx)}` : ''}`);
        }
        out.push('');
    }

    if (doc?.example) out.push('**Example:**', '', '```apex', doc.example, '```', '');
    if (doc?.see.length) {
        out.push(`**See also:** ${doc.see.map((s) => link(s, ctx)).join(', ')}`, '');
    }

    out.push('');
    return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function signatureLabel(member: ConstructorInfo | MethodInfo): string {
    return `${member.name}(${formatParams(member.parameters)})`;
}

function fieldSummary(field: FieldInfo): string {
    const summary = firstSentence(field.doc?.description);
    if (!field.initializer) return summary;
    return summary ? `${summary} Default: \`${field.initializer}\`.` : `Default: \`${field.initializer}\`.`;
}

/** Squeezes text into a single table cell. */
function cell(text: string | undefined, ctx: Context): string {
    if (!text) return '';
    return inline(text, ctx).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|');
}

/** Expands `{@link X}` into a Markdown link when `X` is a documented type. */
function inline(text: string, ctx: Context): string {
    return text.replace(INLINE_LINK_RE, (_all, target: string) => link(target.trim(), ctx));
}

function link(target: string, ctx: Context): string {
    const name = target.split(/[.#\s(]/)[0];
    const decl = ctx.known.get(name);
    if (!decl) return `\`${target}\``;
    const page = decl.isInner ? `${decl.qualifiedName.split('.')[0]}.md` : `${decl.name}.md`;
    return `[\`${target}\`](${page})`;
}
