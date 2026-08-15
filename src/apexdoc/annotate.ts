/**
 * Writes ApexDoc comments back into the source.
 *
 * Two operations, both idempotent:
 *
 *  - **insert** a skeleton above any type or member that has no doc comment;
 *  - **complete** an existing comment that is missing `@param` or `@return`.
 *
 * Edits are applied bottom-up so the line numbers taken from the parse stay
 * valid while the file grows.
 */

import { parseApexSource } from './extractor.js';
import type { ApexDoc, Documentable, TypeDeclaration, Visibility } from './model.js';
import { isVisibleAtLeast, membersOf, walkTypes } from './model.js';

/**
 * Comment block generated above a top-level type when it has none.
 *
 * Placeholders are `{{name}}`, `{{qualifiedName}}`, `{{kind}}`, `{{file}}`,
 * `{{description}}`, `{{author}}`, `{{version}}`, `{{date}}`, `{{dateLong}}`,
 * `{{year}}` and `{{placeholder}}`. An unrecognised `{{tag}}` is left in place
 * rather than blanked, so a typo in a custom template is visible in the output.
 */
export const DEFAULT_HEADER_TEMPLATE = `/**
 * {{description}}
 * @author {{author}}
 * @version {{version}}
 */`;

export interface AnnotateOptions {
    /** Text used where a human has to fill in a description. */
    placeholder: string;
    /** Members less visible than this are left alone. */
    minVisibility: Visibility;
    /** Add missing `@param`/`@return` to comments that already exist. */
    completeExisting: boolean;
    /** Template for the file header comment above a top-level type. */
    headerTemplate: string;
    /** Fills `{{author}}`. Empty falls back to `placeholder`. */
    author: string;
    /** Fills `{{version}}`. Empty falls back to today's date. */
    version: string;
}

export const DEFAULT_ANNOTATE_OPTIONS: AnnotateOptions = {
    placeholder: 'TODO',
    minVisibility: 'private',
    completeExisting: true,
    headerTemplate: DEFAULT_HEADER_TEMPLATE,
    author: '',
    version: '',
};

export interface AnnotateChange {
    line: number;
    kind: 'added' | 'completed';
    target: string;
    /** The tags that were added, for `completed` changes. */
    details: string[];
}

export interface AnnotateResult {
    relativePath: string;
    source: string;
    output: string;
    changes: AnnotateChange[];
}

/** A pending line-level modification. `start` is 1-based. */
interface Edit {
    start: number;
    deleteCount: number;
    lines: string[];
}

/** Documentable elements, outermost first, in source order. */
function documentables(decls: TypeDeclaration[]): Array<{ owner?: TypeDeclaration; member: Documentable }> {
    const out: Array<{ owner?: TypeDeclaration; member: Documentable }> = [];
    for (const root of decls) {
        for (const type of walkTypes(root)) {
            out.push({ member: type });
            for (const member of membersOf(type)) out.push({ owner: type, member });
        }
    }
    return out;
}

function label(entry: { owner?: TypeDeclaration; member: Documentable }): string {
    return entry.owner ? `${entry.owner.qualifiedName}.${entry.member.name}` : entry.member.name;
}

/** `@param`/`@return` lines the member needs but its comment does not have. */
function missingTags(member: Documentable, doc: ApexDoc | undefined, placeholder: string): string[] {
    const tags: string[] = [];

    if (member.kind === 'method' || member.kind === 'constructor') {
        const documented = new Set(doc?.params.map((p) => p.name) ?? []);
        for (const param of member.parameters) {
            if (!documented.has(param.name)) tags.push(`@param ${param.name} ${placeholder}`);
        }
    }

    if (member.kind === 'method' && member.returnType !== 'void' && !doc?.returns) {
        tags.push(`@return ${placeholder}`);
    }

    return tags;
}

/** The comment block generated for an undocumented element. */
function stubFor(member: Documentable, placeholder: string): string[] {
    const description = `${placeholder}: describe ${member.name}.`;
    const tags = missingTags(member, undefined, placeholder);

    // Fields and properties read better on one line; types and callables keep
    // the block form so tags have somewhere to go.
    if (member.kind === 'field' || member.kind === 'property') {
        return [`/** ${description} */`];
    }

    const lines = ['/**', ` * ${description}`];
    if (tags.length > 0) {
        lines.push(' *');
        for (const tag of tags) lines.push(` * ${tag}`);
    }
    lines.push(' */');
    return lines;
}

function indented(lines: string[], indent: string): string[] {
    return lines.map((line) => (line ? indent + line : line));
}

/** True for a type declared at file level, the one that gets the header. */
function isTopLevelType(member: Documentable): member is TypeDeclaration {
    return (
        (member.kind === 'class' || member.kind === 'interface' || member.kind === 'enum') &&
        !member.isInner
    );
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/** Expands the file header template for one top-level type. */
function renderHeader(
    decl: TypeDeclaration,
    options: AnnotateOptions,
    now = new Date(),
): string[] {
    const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const values: Record<string, string> = {
        name: decl.name,
        qualifiedName: decl.qualifiedName,
        kind: decl.kind,
        file: decl.file,
        description: `${options.placeholder}: describe ${decl.name}.`,
        author: options.author || options.placeholder,
        version: options.version || iso,
        date: iso,
        dateLong: `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`,
        year: String(now.getFullYear()),
        placeholder: options.placeholder,
    };

    return options.headerTemplate
        .replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all)
        .split(/\r?\n/);
}

/**
 * Extends an existing comment with the tags it lacks.
 * Returns `undefined` when the comment cannot be edited safely.
 */
function completionEdit(
    doc: ApexDoc,
    tags: string[],
    indent: string,
    sourceLines: string[],
): Edit | undefined {
    const rawLines = doc.raw.split(/\r?\n/);
    const startLine = doc.line;
    const endLine = startLine + rawLines.length - 1;
    const closing = sourceLines[endLine - 1];
    if (closing === undefined) return undefined;

    const added = tags.map((tag) => `${indent} * ${tag}`);

    if (rawLines.length > 1) {
        // Multi-line comment: slip the tags in above the closing `*/`.
        if (closing.trim() !== '*/') return undefined;
        return { start: endLine, deleteCount: 0, lines: added };
    }

    // Single-line comment: expand it into a block so the tags have a home.
    const only = sourceLines[startLine - 1];
    if (only === undefined || only.trim() !== doc.raw.trim()) return undefined;

    const body = doc.raw.replace(/^\/\*\*+/, '').replace(/\*+\/$/, '').trim();
    return {
        start: startLine,
        deleteCount: 1,
        lines: [
            `${indent}/**`,
            ...(body ? [`${indent} * ${body}`, `${indent} *`] : []),
            ...added,
            `${indent} */`,
        ],
    };
}

/** Detects the line ending the file already uses. */
function detectEol(source: string): string {
    return source.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Produces the annotated version of one Apex source file.
 * The input is never modified; the caller decides whether to write `output`.
 */
export function annotateSource(
    source: string,
    relativePath: string,
    options: AnnotateOptions = DEFAULT_ANNOTATE_OPTIONS,
): AnnotateResult {
    const parsed = parseApexSource(source, relativePath, relativePath);
    const eol = detectEol(source);
    const lines = source.split(/\r?\n/);

    const edits: Edit[] = [];
    const changes: AnnotateChange[] = [];

    for (const entry of documentables(parsed.declarations)) {
        const { member } = entry;
        if (!isVisibleAtLeast(member.visibility, options.minVisibility)) continue;

        if (!member.doc) {
            // A top-level type gets the file header template; everything else
            // gets the plain stub.
            const block = isTopLevelType(member)
                ? renderHeader(member, options)
                : stubFor(member, options.placeholder);

            edits.push({
                start: member.anchorLine,
                deleteCount: 0,
                lines: indented(block, member.indent),
            });
            changes.push({
                line: member.anchorLine,
                kind: 'added',
                target: label(entry),
                details: [],
            });
            continue;
        }

        if (!options.completeExisting) continue;

        const tags = missingTags(member, member.doc, options.placeholder);
        if (tags.length === 0) continue;

        const edit = completionEdit(member.doc, tags, member.indent, lines);
        if (!edit) continue;

        edits.push(edit);
        changes.push({
            line: member.doc.line,
            kind: 'completed',
            target: label(entry),
            details: tags,
        });
    }

    // Bottom-up so earlier line numbers stay meaningful.
    edits.sort((a, b) => b.start - a.start);
    const output = [...lines];
    for (const edit of edits) {
        output.splice(edit.start - 1, edit.deleteCount, ...edit.lines);
    }

    changes.sort((a, b) => a.line - b.line);

    return {
        relativePath,
        source,
        output: output.join(eol),
        changes,
    };
}
