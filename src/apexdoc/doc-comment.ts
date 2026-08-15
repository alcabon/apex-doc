/**
 * Parser for ApexDoc / JavaDoc style block comments.
 *
 * Supported layouts — both are accepted, JavaDoc-style leading prose and the
 * explicit `@description` tag ApexDoc introduced:
 *
 *     /**
 *      * Creates an account.
 *      * @param name Name of the account
 *      * @return The inserted account
 *      *\/
 */

import type { ApexDoc, ParamDoc, ThrowsDoc, UnknownTag } from './model.js';

/** Tags this tool understands. Anything else is kept in `unknownTags`. */
const KNOWN_TAGS = new Set([
    'description',
    'param',
    'return',
    'returns',
    'throws',
    'exception',
    'author',
    'date',
    'since',
    'version',
    'group',
    'group-content',
    'see',
    'example',
    'deprecated',
]);

/** `{@link Something}` — resolved to a cross-reference by the renderers. */
export const INLINE_LINK_RE = /\{@link\s+([^}]+)\}/g;

interface TagBlock {
    tag: string;
    /** Lines of the tag body, the first one being the text after `@tag`. */
    lines: string[];
}

/**
 * Strips the comment markers and returns the payload lines.
 * `/**`, the trailing `*\/` and each line's leading ` * ` are removed.
 */
function stripCommentMarkers(raw: string): string[] {
    const body = raw
        .replace(/^\s*\/\*\*+/, '')
        .replace(/\*+\/\s*$/, '');

    return body
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*(?!\/)\s?/, '').replace(/\s+$/, ''));
}

/** Splits the payload into the leading description and the tag blocks. */
function splitTags(lines: string[]): { description: string[]; tags: TagBlock[] } {
    const description: string[] = [];
    const tags: TagBlock[] = [];
    let current: TagBlock | undefined;

    for (const line of lines) {
        const match = line.match(/^\s*@([A-Za-z][\w-]*)[ \t]*(.*)$/);
        if (match) {
            current = { tag: match[1].toLowerCase(), lines: [match[2]] };
            tags.push(current);
        } else if (current) {
            current.lines.push(line);
        } else {
            description.push(line);
        }
    }

    return { description, tags };
}

/** Joins a tag body, collapsing the blank padding around it. */
function joinBlock(lines: string[]): string {
    return lines.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
}

/** `@example` is code: keep the line breaks and the relative indentation. */
function joinCode(lines: string[]): string {
    const kept = [...lines];
    while (kept.length && kept[0].trim() === '') kept.shift();
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    if (kept.length === 0) return '';

    const indents = kept
        .filter((l) => l.trim() !== '')
        .map((l) => l.match(/^ */)![0].length);
    const common = Math.min(...indents);
    return kept.map((l) => l.slice(common)).join('\n');
}

/** `@param name The description` — the name is the first whitespace-free token. */
function parseNamed(content: string): { name: string; description: string } {
    const match = content.match(/^\s*(\S+)\s*([\s\S]*)$/);
    if (!match) return { name: content.trim(), description: '' };
    return { name: match[1], description: match[2].trim() };
}

/**
 * Parses one block comment.
 *
 * @param raw  The comment text, `/**` and `*\/` included.
 * @param line 1-based line number of the opening `/**`.
 */
export function parseDocComment(raw: string, line: number): ApexDoc {
    const doc: ApexDoc = {
        description: '',
        params: [],
        throws: [],
        see: [],
        unknownTags: [],
        raw,
        line,
    };

    const { description, tags } = splitTags(stripCommentMarkers(raw));
    doc.description = joinBlock(description);

    for (const block of tags) {
        const content = joinBlock(block.lines);

        switch (block.tag) {
            case 'description':
                // An explicit @description wins over leading prose; if both are
                // present they are kept together rather than one shadowing the other.
                doc.description = doc.description ? `${doc.description}\n${content}` : content;
                break;
            case 'param': {
                const { name, description: text } = parseNamed(content);
                if (name) doc.params.push({ name, description: text } satisfies ParamDoc);
                break;
            }
            case 'return':
            case 'returns':
                doc.returns = content;
                break;
            case 'throws':
            case 'exception': {
                const { name, description: text } = parseNamed(content);
                if (name) doc.throws.push({ type: name, description: text } satisfies ThrowsDoc);
                break;
            }
            case 'author':
                doc.author = content;
                break;
            case 'date':
                doc.date = content;
                break;
            case 'since':
                doc.since = content;
                break;
            case 'version':
                doc.version = content;
                break;
            case 'group':
                doc.group = content;
                break;
            case 'group-content':
                doc.groupContent = content;
                break;
            case 'see':
                if (content) doc.see.push(content);
                break;
            case 'example':
                doc.example = joinCode(block.lines);
                break;
            case 'deprecated':
                // `@deprecated` with no text is still a deprecation marker.
                doc.deprecated = content || 'This element is deprecated.';
                break;
            default:
                if (!KNOWN_TAGS.has(block.tag)) {
                    doc.unknownTags.push({ tag: block.tag, value: content } satisfies UnknownTag);
                }
        }
    }

    return doc;
}

/** True when the comment carries no information at all. */
export function isEmptyDoc(doc: ApexDoc): boolean {
    return (
        !doc.description.trim() &&
        doc.params.length === 0 &&
        !doc.returns &&
        doc.throws.length === 0 &&
        !doc.deprecated &&
        !doc.example &&
        doc.see.length === 0
    );
}
