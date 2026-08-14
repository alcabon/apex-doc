/**
 * Turns Apex source into the documentation model.
 *
 * Two things make this different from a naive visitor:
 *
 *  1. Doc comments are read from the lexer's hidden comment channel and bound
 *     to a declaration by *token adjacency*, not by guessing line offsets. A
 *     comment attaches only when nothing but whitespace and ordinary comments
 *     separates it from the declaration it precedes.
 *  2. The traversal is explicit and typed. It walks class bodies only, so
 *     method bodies — the bulk of any real class — are never visited.
 */

import {
    ApexLexer,
    ApexParser,
    CaseInsensitiveInputStream,
    CommonTokenStream,
    type ClassBodyContext,
    type ClassDeclarationContext,
    type EnumDeclarationContext,
    type FormalParametersContext,
    type InterfaceBodyContext,
    type InterfaceDeclarationContext,
    type ModifierContext,
    type TypeRefContext,
} from '@apexdevtools/apex-parser';
import { CharStreams, ParserRuleContext, Token } from 'antlr4ts';
import { Interval } from 'antlr4ts/misc/Interval.js';

import { parseDocComment } from './doc-comment.js';
import type {
    ApexDoc,
    ApexFile,
    ClassInfo,
    ConstructorInfo,
    EnumConstantInfo,
    EnumInfo,
    FieldInfo,
    InterfaceInfo,
    MethodInfo,
    ParameterInfo,
    ParseError,
    PropertyInfo,
    TypeDeclaration,
    Visibility,
} from './model.js';

/** Token type of `/** ... *\/` in the Apex lexer. */
const DOC_COMMENT = ApexLexer.DOC_COMMENT;
/** Channel carrying every kind of comment. */
const COMMENT_CHANNEL = ApexLexer.COMMENT_CHANNEL;

const VISIBILITY_KEYWORDS = new Set<string>(['global', 'public', 'protected', 'private']);

// ---------------------------------------------------------------------------
// Doc comment index
// ---------------------------------------------------------------------------

/**
 * Finds the doc comment attached to a declaration.
 *
 * A comment binds to the token that follows it, so we walk left from the first
 * token of the declaration (its first annotation or modifier). Whitespace and
 * non-doc comments are skipped; any real token ends the search, which is what
 * stops a class-level comment from leaking onto the first member.
 */
class DocIndex {
    private readonly parsed = new Map<number, ApexDoc>();

    constructor(private readonly tokens: Token[]) {}

    before(tokenIndex: number): ApexDoc | undefined {
        for (let i = tokenIndex - 1; i >= 0; i--) {
            const token = this.tokens[i];
            if (token.channel === Token.DEFAULT_CHANNEL) return undefined;
            if (token.type === DOC_COMMENT) return this.parse(token);
            if (token.channel !== COMMENT_CHANNEL && !isWhitespace(token)) return undefined;
        }
        return undefined;
    }

    private parse(token: Token): ApexDoc {
        const cached = this.parsed.get(token.tokenIndex);
        if (cached) return cached;
        const doc = parseDocComment(token.text ?? '', token.line);
        this.parsed.set(token.tokenIndex, doc);
        return doc;
    }
}

function isWhitespace(token: Token): boolean {
    return (token.text ?? '').trim() === '';
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface Modifiers {
    keywords: string[];
    annotations: string[];
}

class Builder {
    readonly declarations: TypeDeclaration[] = [];

    constructor(
        private readonly file: string,
        private readonly lines: string[],
        private readonly docs: DocIndex,
    ) {}

    // -- types ---------------------------------------------------------------

    buildClass(
        ctx: ClassDeclarationContext,
        mods: Modifiers,
        anchor: Token,
        doc: ApexDoc | undefined,
        parent?: TypeDeclaration,
    ): ClassInfo {
        const name = text(ctx.id());
        const info: ClassInfo = {
            kind: 'class',
            qualifiedName: parent ? `${parent.qualifiedName}.${name}` : name,
            file: this.file,
            isInner: parent !== undefined,
            extends: ctx.typeRef() ? this.typeText(ctx.typeRef()!) : undefined,
            implements: (ctx.typeList()?.typeRef() ?? []).map((t) => this.typeText(t)),
            constructors: [],
            methods: [],
            properties: [],
            fields: [],
            innerTypes: [],
            ...this.memberBase(name, mods, anchor, ctx, doc, parent ? 'private' : 'public'),
        };

        this.readClassBody(ctx.classBody(), info);
        return info;
    }

    buildInterface(
        ctx: InterfaceDeclarationContext,
        mods: Modifiers,
        anchor: Token,
        doc: ApexDoc | undefined,
        parent?: TypeDeclaration,
    ): InterfaceInfo {
        const name = text(ctx.id());
        const info: InterfaceInfo = {
            kind: 'interface',
            qualifiedName: parent ? `${parent.qualifiedName}.${name}` : name,
            file: this.file,
            isInner: parent !== undefined,
            extends: (ctx.typeList()?.typeRef() ?? []).map((t) => this.typeText(t)),
            methods: [],
            ...this.memberBase(name, mods, anchor, ctx, doc, parent ? 'private' : 'public'),
        };

        this.readInterfaceBody(ctx.interfaceBody(), info);
        return info;
    }

    buildEnum(
        ctx: EnumDeclarationContext,
        mods: Modifiers,
        anchor: Token,
        doc: ApexDoc | undefined,
        parent?: TypeDeclaration,
    ): EnumInfo {
        const name = text(ctx.id());
        const constants: EnumConstantInfo[] = (ctx.enumConstants()?.id() ?? []).map((id) => ({
            name: text(id),
            line: id.start.line,
            doc: this.docs.before(id.start.tokenIndex),
        }));

        return {
            kind: 'enum',
            qualifiedName: parent ? `${parent.qualifiedName}.${name}` : name,
            file: this.file,
            isInner: parent !== undefined,
            constants,
            ...this.memberBase(name, mods, anchor, ctx, doc, parent ? 'private' : 'public'),
        };
    }

    // -- bodies --------------------------------------------------------------

    private readClassBody(body: ClassBodyContext, owner: ClassInfo): void {
        for (const decl of body.classBodyDeclaration()) {
            const member = decl.memberDeclaration();
            if (!member) continue; // `;` or a static/instance initializer block

            const mods = splitModifiers(decl.modifier());
            const anchor = decl.start;
            const doc = this.docs.before(anchor.tokenIndex);

            const method = member.methodDeclaration();
            if (method) {
                owner.methods.push({
                    kind: 'method',
                    returnType: method.typeRef() ? this.typeText(method.typeRef()!) : 'void',
                    parameters: this.parameters(method.formalParameters()),
                    isAbstract: !method.block(),
                    ...this.memberBase(text(method.id()), mods, anchor, method, doc, 'private'),
                } as MethodInfo);
                continue;
            }

            const ctor = member.constructorDeclaration();
            if (ctor) {
                owner.constructors.push({
                    kind: 'constructor',
                    parameters: this.parameters(ctor.formalParameters()),
                    ...this.memberBase(
                        this.sourceText(ctor.qualifiedName()),
                        mods,
                        anchor,
                        ctor,
                        doc,
                        'private',
                    ),
                } as ConstructorInfo);
                continue;
            }

            const property = member.propertyDeclaration();
            if (property) {
                const blocks = property.propertyBlock();
                owner.properties.push({
                    kind: 'property',
                    type: this.typeText(property.typeRef()),
                    hasGetter: blocks.some((b) => b.getter() !== undefined),
                    hasSetter: blocks.some((b) => b.setter() !== undefined),
                    ...this.memberBase(text(property.id()), mods, anchor, property, doc, 'private'),
                } as PropertyInfo);
                continue;
            }

            const field = member.fieldDeclaration();
            if (field) {
                const type = this.typeText(field.typeRef());
                // `private Integer a = 1, b = 2;` declares two fields that share
                // one doc comment.
                for (const declarator of field.variableDeclarators().variableDeclarator()) {
                    const expr = declarator.expression();
                    owner.fields.push({
                        kind: 'field',
                        type,
                        initializer: expr ? this.sourceText(expr) : undefined,
                        isFinal: mods.keywords.includes('final'),
                        ...this.memberBase(text(declarator.id()), mods, anchor, field, doc, 'private'),
                    } as FieldInfo);
                }
                continue;
            }

            const innerClass = member.classDeclaration();
            if (innerClass) {
                owner.innerTypes.push(this.buildClass(innerClass, mods, anchor, doc, owner));
                continue;
            }

            const innerInterface = member.interfaceDeclaration();
            if (innerInterface) {
                owner.innerTypes.push(this.buildInterface(innerInterface, mods, anchor, doc, owner));
                continue;
            }

            const innerEnum = member.enumDeclaration();
            if (innerEnum) {
                owner.innerTypes.push(this.buildEnum(innerEnum, mods, anchor, doc, owner));
            }
        }
    }

    private readInterfaceBody(body: InterfaceBodyContext, owner: InterfaceInfo): void {
        for (const method of body.interfaceMethodDeclaration()) {
            const mods = splitModifiers(method.modifier());
            const anchor = method.start;
            owner.methods.push({
                kind: 'method',
                returnType: method.typeRef() ? this.typeText(method.typeRef()!) : 'void',
                parameters: this.parameters(method.formalParameters()),
                isAbstract: true,
                // Interface members are implicitly public.
                ...this.memberBase(
                    text(method.id()),
                    mods,
                    anchor,
                    method,
                    this.docs.before(anchor.tokenIndex),
                    'public',
                ),
            } as MethodInfo);
        }
    }

    // -- shared pieces -------------------------------------------------------

    private memberBase(
        name: string,
        mods: Modifiers,
        anchor: Token,
        ctx: ParserRuleContext,
        doc: ApexDoc | undefined,
        defaultVisibility: Visibility,
    ) {
        const anchorLine = anchor.line;
        return {
            name,
            modifiers: mods.keywords,
            annotations: mods.annotations,
            visibility: visibilityOf(mods.keywords, defaultVisibility),
            isStatic: mods.keywords.includes('static'),
            startLine: ctx.start.line,
            anchorLine,
            endLine: ctx.stop?.line ?? ctx.start.line,
            indent: indentOf(this.lines[anchorLine - 1] ?? ''),
            doc,
        };
    }

    private parameters(ctx: FormalParametersContext): ParameterInfo[] {
        return (ctx.formalParameterList()?.formalParameter() ?? []).map((param) => ({
            name: text(param.id()),
            type: this.typeText(param.typeRef()),
        }));
    }

    /** Type as the author wrote it, with line breaks collapsed. */
    private typeText(ctx: TypeRefContext): string {
        return this.sourceText(ctx).replace(/\s+/g, ' ').trim();
    }

    /**
     * Original source slice for a context.
     *
     * `ctx.text` concatenates token texts and so drops every space —
     * `new List<Account>()` would come out as `newList<Account>()`.
     */
    private sourceText(ctx: ParserRuleContext): string {
        const input = ctx.start.inputStream;
        if (!input || ctx.stop === undefined) return ctx.text;
        return input.getText(Interval.of(ctx.start.startIndex, ctx.stop.stopIndex));
    }
}

function text(ctx: ParserRuleContext): string {
    return ctx.text;
}

function indentOf(line: string): string {
    return line.match(/^[ \t]*/)![0];
}

/** Splits `modifier*` into annotations and plain keywords. */
function splitModifiers(mods: ModifierContext[]): Modifiers {
    const keywords: string[] = [];
    const annotations: string[] = [];

    for (const mod of mods) {
        const annotation = mod.annotation();
        if (annotation) {
            annotations.push(annotation.text);
            continue;
        }
        // Multi-word modifiers (`with sharing`) are separate terminals inside a
        // single rule, so join the children rather than using `.text`.
        const words: string[] = [];
        for (let i = 0; i < mod.childCount; i++) {
            words.push(mod.getChild(i).text);
        }
        keywords.push(words.join(' ').toLowerCase());
    }

    return { keywords, annotations };
}

function visibilityOf(keywords: string[], fallback: Visibility): Visibility {
    for (const keyword of keywords) {
        if (VISIBILITY_KEYWORDS.has(keyword)) return keyword as Visibility;
    }
    return fallback;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses one Apex compilation unit.
 *
 * Syntax errors are collected instead of thrown: a file that half-parses still
 * yields the declarations the parser managed to recover.
 */
export function parseApexSource(
    source: string,
    file: string,
    relativePath = file,
): ApexFile {
    const errors: ParseError[] = [];
    const collect = {
        syntaxError(
            _recognizer: unknown,
            _offending: unknown,
            line: number,
            column: number,
            message: string,
        ): void {
            errors.push({ file: relativePath, line, column, message });
        },
    };

    const lexer = new ApexLexer(new CaseInsensitiveInputStream(CharStreams.fromString(source)));
    lexer.removeErrorListeners();
    lexer.addErrorListener(collect);

    const tokenStream = new CommonTokenStream(lexer);
    const parser = new ApexParser(tokenStream);
    parser.removeErrorListeners();
    parser.addErrorListener(collect);

    const unit = parser.compilationUnit();
    tokenStream.fill();

    const docs = new DocIndex(tokenStream.getTokens());
    const builder = new Builder(relativePath, source.split(/\r?\n/), docs);

    // `typeDeclaration` is typed as always present but is absent on a file the
    // parser could not recover.
    const typeDecl = unit.typeDeclaration() as ReturnType<typeof unit.typeDeclaration> | undefined;
    if (typeDecl) {
        const mods = splitModifiers(typeDecl.modifier());
        const anchor = typeDecl.start;
        const doc = docs.before(anchor.tokenIndex);

        const classDecl = typeDecl.classDeclaration();
        const interfaceDecl = typeDecl.interfaceDeclaration();
        const enumDecl = typeDecl.enumDeclaration();

        if (classDecl) {
            builder.declarations.push(builder.buildClass(classDecl, mods, anchor, doc));
        } else if (interfaceDecl) {
            builder.declarations.push(builder.buildInterface(interfaceDecl, mods, anchor, doc));
        } else if (enumDecl) {
            builder.declarations.push(builder.buildEnum(enumDecl, mods, anchor, doc));
        }
    }

    return { path: file, relativePath, declarations: builder.declarations, errors };
}
