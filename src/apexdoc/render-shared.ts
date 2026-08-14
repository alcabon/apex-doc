/** Presentation helpers used by both renderers. */

import type { Documentable, TypeDeclaration } from './model.js';

const UNGROUPED = 'Other';

/** A rendered output file. */
export interface Page {
    fileName: string;
    content: string;
}

/** Modifiers worth showing in JavaDoc's "Modifier and Type" column. */
const SHOWN_MODIFIERS = ['global', 'public', 'protected', 'private', 'static', 'final', 'abstract', 'virtual', 'override', 'transient', 'webservice'];

/** `Class AccountService`, `Interface IAccountProcessor`, `Enum Status`. */
export function typeLabel(decl: TypeDeclaration): string {
    const kind = decl.kind[0].toUpperCase() + decl.kind.slice(1);
    return `${kind} ${decl.qualifiedName}`;
}

/** The modifier list shown in summary tables, in a stable order. */
export function modifierColumn(member: Documentable): string {
    const present = new Set(member.modifiers);
    return SHOWN_MODIFIERS.filter((m) => present.has(m)).join(' ');
}

/**
 * Groups top-level types by their `@group` tag, the closest ApexDoc has to a
 * JavaDoc package. Ungrouped types are collected last.
 */
export function groupsOf(types: TypeDeclaration[]): Array<[string, TypeDeclaration[]]> {
    const byGroup = new Map<string, TypeDeclaration[]>();

    for (const decl of types) {
        const group = decl.doc?.group?.trim() || UNGROUPED;
        const bucket = byGroup.get(group);
        if (bucket) bucket.push(decl);
        else byGroup.set(group, [decl]);
    }

    return [...byGroup.entries()]
        .sort(([a], [b]) => {
            if (a === UNGROUPED) return 1;
            if (b === UNGROUPED) return -1;
            return a.localeCompare(b);
        })
        .map(([group, members]) => [group, members.sort((x, y) => x.name.localeCompare(y.name))]);
}

/** GitHub-compatible heading anchor, so the Markdown summary links resolve. */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

/** HTML-escapes a string for use in text nodes and attribute values. */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
