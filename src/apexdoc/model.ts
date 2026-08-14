/**
 * Data model shared by the parser, the validator and the renderers.
 *
 * Everything the renderers need must live here: the renderers never touch
 * ANTLR contexts, so the model is the single contract between the two halves
 * of the tool.
 */

/** Apex access levels, ordered from the most visible to the least visible. */
export type Visibility = 'global' | 'public' | 'protected' | 'private';

export const VISIBILITY_ORDER: Visibility[] = ['global', 'public', 'protected', 'private'];

/** `@param name description` */
export interface ParamDoc {
    name: string;
    description: string;
}

/** `@throws TypeName description` */
export interface ThrowsDoc {
    type: string;
    description: string;
}

/** A tag the tool does not know about; kept so nothing is silently dropped. */
export interface UnknownTag {
    tag: string;
    value: string;
}

/** A parsed `/** ... *\/` block. */
export interface ApexDoc {
    description: string;
    params: ParamDoc[];
    returns?: string;
    throws: ThrowsDoc[];
    author?: string;
    date?: string;
    since?: string;
    group?: string;
    groupContent?: string;
    see: string[];
    example?: string;
    deprecated?: string;
    unknownTags: UnknownTag[];
    /** Raw comment text, `/**` and `*\/` included. */
    raw: string;
    /** 1-based line of the `/**`. */
    line: number;
}

export interface ParameterInfo {
    name: string;
    type: string;
}

/** Fields every documentable element carries. */
export interface MemberBase {
    name: string;
    /** Keyword modifiers only (`public`, `static`, `final`, ...). */
    modifiers: string[];
    /** Annotations, text included: `@AuraEnabled(cacheable=true)`. */
    annotations: string[];
    visibility: Visibility;
    isStatic: boolean;
    /** Line of the declaration keyword itself. */
    startLine: number;
    /**
     * First line of the whole declaration, annotations and modifiers included.
     * This is where `annotate` inserts a generated doc comment.
     */
    anchorLine: number;
    endLine: number;
    /** Indentation of the anchor line, reused when generating doc comments. */
    indent: string;
    doc?: ApexDoc;
}

export interface FieldInfo extends MemberBase {
    kind: 'field';
    type: string;
    initializer?: string;
    isFinal: boolean;
}

export interface PropertyInfo extends MemberBase {
    kind: 'property';
    type: string;
    hasGetter: boolean;
    hasSetter: boolean;
}

export interface MethodInfo extends MemberBase {
    kind: 'method';
    returnType: string;
    parameters: ParameterInfo[];
    /** True for interface methods and `abstract` methods (no body). */
    isAbstract: boolean;
}

export interface ConstructorInfo extends MemberBase {
    kind: 'constructor';
    parameters: ParameterInfo[];
}

export interface EnumConstantInfo {
    name: string;
    line: number;
    doc?: ApexDoc;
}

interface TypeBase extends MemberBase {
    /** `Outer.Inner` for nested types, `Outer` otherwise. */
    qualifiedName: string;
    isInner: boolean;
    /** Source file this type was read from. */
    file: string;
}

export interface ClassInfo extends TypeBase {
    kind: 'class';
    extends?: string;
    implements: string[];
    constructors: ConstructorInfo[];
    methods: MethodInfo[];
    properties: PropertyInfo[];
    fields: FieldInfo[];
    innerTypes: TypeDeclaration[];
}

export interface InterfaceInfo extends TypeBase {
    kind: 'interface';
    extends: string[];
    methods: MethodInfo[];
}

export interface EnumInfo extends TypeBase {
    kind: 'enum';
    constants: EnumConstantInfo[];
}

export type TypeDeclaration = ClassInfo | InterfaceInfo | EnumInfo;

/** Any element that can carry a doc comment. */
export type Documentable =
    | TypeDeclaration
    | ConstructorInfo
    | MethodInfo
    | PropertyInfo
    | FieldInfo;

export interface ParseError {
    file: string;
    line: number;
    column: number;
    message: string;
}

/** One parsed `.cls` file. */
export interface ApexFile {
    /** Absolute path on disk. */
    path: string;
    /** Path relative to the root that was scanned, used in reports. */
    relativePath: string;
    declarations: TypeDeclaration[];
    errors: ParseError[];
}

/** Everything a renderer receives. */
export interface Project {
    title: string;
    files: ApexFile[];
    /** Top-level types across all files, sorted by name. */
    types: TypeDeclaration[];
}

// ---------------------------------------------------------------------------
// Small helpers used by every renderer
// ---------------------------------------------------------------------------

export function visibilityRank(v: Visibility): number {
    return VISIBILITY_ORDER.indexOf(v);
}

/** True when `v` is at least as visible as `minimum`. */
export function isVisibleAtLeast(v: Visibility, minimum: Visibility): boolean {
    return visibilityRank(v) <= visibilityRank(minimum);
}

/** Direct children of a type, flattened for recursive walks. */
export function innerTypesOf(decl: TypeDeclaration): TypeDeclaration[] {
    return decl.kind === 'class' ? decl.innerTypes : [];
}

/** `decl` and every type nested inside it, depth first. */
export function walkTypes(decl: TypeDeclaration): TypeDeclaration[] {
    return [decl, ...innerTypesOf(decl).flatMap(walkTypes)];
}

/** The methods/constructors/properties/fields of a type, in declaration order. */
export function membersOf(decl: TypeDeclaration): Documentable[] {
    if (decl.kind === 'class') {
        return [...decl.constructors, ...decl.fields, ...decl.properties, ...decl.methods];
    }
    if (decl.kind === 'interface') {
        return [...decl.methods];
    }
    return [];
}

/** `getFullName(String, String)` — the JavaDoc-style anchor id for a member. */
export function memberSignatureId(member: Documentable): string {
    if ('parameters' in member && Array.isArray(member.parameters)) {
        const types = member.parameters.map((p) => p.type.replace(/\s+/g, ''));
        return `${member.name}(${types.join(',')})`;
    }
    return member.name;
}

/** The declaration line as it would be written in Apex, without the body. */
export function declarationOf(member: Documentable): string {
    const prefix = [...member.annotations, ...member.modifiers].join(' ');
    const head = prefix ? `${prefix} ` : '';

    switch (member.kind) {
        case 'constructor':
            return `${head}${member.name}(${formatParams(member.parameters)})`;
        case 'method':
            return `${head}${member.returnType} ${member.name}(${formatParams(member.parameters)})`;
        case 'property': {
            const accessors = [
                member.hasGetter ? 'get;' : null,
                member.hasSetter ? 'set;' : null,
            ].filter(Boolean).join(' ');
            return `${head}${member.type} ${member.name} { ${accessors} }`;
        }
        case 'field':
            return `${head}${member.type} ${member.name}${member.initializer ? ` = ${member.initializer}` : ''}`;
        case 'class': {
            const ext = member.extends ? ` extends ${member.extends}` : '';
            const impl = member.implements.length ? ` implements ${member.implements.join(', ')}` : '';
            return `${head}class ${member.name}${ext}${impl}`;
        }
        case 'interface': {
            const ext = member.extends.length ? ` extends ${member.extends.join(', ')}` : '';
            return `${head}interface ${member.name}${ext}`;
        }
        case 'enum':
            return `${head}enum ${member.name}`;
    }
}

export function formatParams(params: ParameterInfo[]): string {
    return params.map((p) => `${p.type} ${p.name}`).join(', ');
}

/** JavaDoc uses the first sentence of a description in its summary tables. */
export function firstSentence(text: string | undefined): string {
    if (!text) return '';
    const flat = text.replace(/\s+/g, ' ').trim();
    const match = flat.match(/^(.*?[.!?])(\s|$)/);
    return (match ? match[1] : flat).trim();
}
