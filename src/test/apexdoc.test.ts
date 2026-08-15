/**
 * Test suite for the generator. Run with `npm test`.
 *
 * Uses the Node built-in runner, so there is nothing to install.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_ANNOTATE_OPTIONS,
    DEFAULT_HEADER_TEMPLATE,
    annotateSource,
} from '../apexdoc/annotate.js';
import { parseApexSource } from '../apexdoc/extractor.js';
import type { ClassInfo, EnumInfo, InterfaceInfo, Project } from '../apexdoc/model.js';
import { renderHtml } from '../apexdoc/render-html.js';
import { renderMarkdown } from '../apexdoc/render-markdown.js';
import { slugify } from '../apexdoc/render-shared.js';
import { validateProject } from '../apexdoc/validate.js';

function parseClass(source: string): ClassInfo {
    const file = parseApexSource(source, 'Test.cls');
    assert.deepEqual(file.errors, [], 'source should parse without errors');
    const decl = file.declarations[0];
    assert.equal(decl?.kind, 'class');
    return decl as ClassInfo;
}

function projectOf(source: string, name = 'Test.cls'): Project {
    const file = parseApexSource(source, name);
    return { title: 'Test', files: [file], types: file.declarations };
}

// ---------------------------------------------------------------------------
// Type extraction
// ---------------------------------------------------------------------------

test('preserves deeply nested generic types', () => {
    const info = parseClass(`
public class Generics {
    private List<List<List<Integer>>> cube;
    private Map<String, Map<Id, List<Set<Account>>>> ultra;
    public Map<String, List<List<String>>> matrix { get; set; }

    public List<List<String>> getMatrix() {
        return new List<List<String>>();
    }

    public void process(Map<String, List<List<Account>>> data, List<List<Integer>> numbers) {}
}
`);

    assert.equal(info.fields[0].type, 'List<List<List<Integer>>>');
    assert.equal(info.fields[1].type, 'Map<String, Map<Id, List<Set<Account>>>>');
    assert.equal(info.properties[0].type, 'Map<String, List<List<String>>>');
    assert.equal(info.methods[0].returnType, 'List<List<String>>');
    assert.deepEqual(
        info.methods[1].parameters.map((p) => p.type),
        ['Map<String, List<List<Account>>>', 'List<List<Integer>>'],
    );
});

test('keeps initializers as written in the source', () => {
    const info = parseClass(`
public class Init {
    private String label = 'Default Account';
    private List<Account> items = new List<Account>();
}
`);

    assert.equal(info.fields[0].initializer, "'Default Account'");
    assert.equal(info.fields[1].initializer, 'new List<Account>()');
});

test('reads modifiers, annotations and visibility', () => {
    const info = parseClass(`
@IsTest
public with sharing class Modifiers {
    @AuraEnabled(cacheable=true)
    public static Integer counter = 0;

    protected virtual void hook() {}

    void implicitlyPrivate() {}
}
`);

    assert.deepEqual(info.modifiers, ['public', 'with sharing']);
    assert.deepEqual(info.annotations, ['@IsTest']);
    assert.deepEqual(info.fields[0].annotations, ['@AuraEnabled(cacheable=true)']);
    assert.equal(info.fields[0].isStatic, true);
    assert.equal(info.methods[0].visibility, 'protected');
    assert.equal(info.methods[1].visibility, 'private');
});

test('collects declarations from a file that only half parses', () => {
    const file = parseApexSource('public class Broken { public void ok() {} ;;; @@@ }', 'Broken.cls');
    assert.ok(file.errors.length > 0, 'expected syntax errors to be reported');
    assert.equal(file.declarations[0]?.name, 'Broken');
});

// ---------------------------------------------------------------------------
// Doc comment binding
// ---------------------------------------------------------------------------

test('binds doc comments to the declaration that follows them', () => {
    const info = parseClass(`
/**
 * Does things.
 * @author Ada
 * @group Utilities
 */
public class Documented {
    /** The label. */
    private String label;

    /**
     * Joins two names.
     *
     * @param first  Given name.
     * @param last   Family name.
     * @return The joined name.
     * @throws IllegalArgumentException When either part is blank.
     */
    public String join(String first, String last) {
        return first + last;
    }

    // Not a doc comment.
    public void undocumented() {}
}
`);

    assert.equal(info.doc?.description, 'Does things.');
    assert.equal(info.doc?.author, 'Ada');
    assert.equal(info.doc?.group, 'Utilities');
    assert.equal(info.fields[0].doc?.description, 'The label.');

    const join = info.methods[0];
    assert.equal(join.doc?.description, 'Joins two names.');
    assert.deepEqual(
        join.doc?.params.map((p) => [p.name, p.description]),
        [['first', 'Given name.'], ['last', 'Family name.']],
    );
    assert.equal(join.doc?.returns, 'The joined name.');
    assert.deepEqual(join.doc?.throws, [
        { type: 'IllegalArgumentException', description: 'When either part is blank.' },
    ]);

    // The class comment must not leak onto a member that has none.
    assert.equal(info.methods[1].doc, undefined);
});

test('a doc comment on the class does not attach to its first member', () => {
    const info = parseClass(`
/** Class level. */
public class Leak {
    public void first() {}
}
`);

    assert.equal(info.doc?.description, 'Class level.');
    assert.equal(info.methods[0].doc, undefined);
});

test('keeps @example formatting and supports the @description tag', () => {
    const info = parseClass(`
public class Examples {
    /**
     * @description Runs a query.
     * @example
     * List<Account> a = [SELECT Id FROM Account];
     *     System.debug(a);
     */
    public void run() {}
}
`);

    const doc = info.methods[0].doc;
    assert.equal(doc?.description, 'Runs a query.');
    assert.equal(doc?.example, 'List<Account> a = [SELECT Id FROM Account];\n    System.debug(a);');
});

test('documents interfaces, enums and nested types', () => {
    const file = parseApexSource(
        `
/** A contract. */
public interface Contract {
    /**
     * Runs it.
     * @param value Input.
     * @return Whether it worked.
     */
    Boolean run(Integer value);
}
`,
        'Contract.cls',
    );
    const contract = file.declarations[0] as InterfaceInfo;
    assert.equal(contract.kind, 'interface');
    assert.equal(contract.methods[0].visibility, 'public');
    assert.equal(contract.methods[0].isAbstract, true);

    const outer = parseClass(`
public class Outer {
    /** Nested states. */
    public enum State {
        /** Waiting. */
        PENDING,
        /** Finished. */
        DONE
    }

    /** Nested helper. */
    private class Helper {
        public void help() {}
    }
}
`);

    const [state, helper] = outer.innerTypes;
    assert.equal(state.qualifiedName, 'Outer.State');
    assert.deepEqual((state as EnumInfo).constants.map((c) => c.name), ['PENDING', 'DONE']);
    assert.equal((state as EnumInfo).constants[0].doc?.description, 'Waiting.');
    assert.equal(helper.visibility, 'private');
    assert.equal((helper as ClassInfo).methods[0].name, 'help');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('reports missing and inconsistent documentation', () => {
    const project = projectOf(`
public class Checked {
    /**
     * Adds numbers.
     * @param a First.
     * @param c Not a parameter.
     */
    public Integer add(Integer a, Integer b) {
        return a + b;
    }

    /**
     * Does nothing.
     * @return Nothing at all.
     */
    public void noop() {}
}
`);

    const rules = validateProject(project).issues.map((issue) => issue.rule);
    assert.ok(rules.includes('missing-doc'), 'class has no doc comment');
    assert.ok(rules.includes('missing-param'), '@param b is missing');
    assert.ok(rules.includes('unknown-param'), '@param c matches nothing');
    assert.ok(rules.includes('missing-return'), 'add() returns a value');
    assert.ok(rules.includes('spurious-return'), 'noop() returns void');
});

test('counts documentation coverage', () => {
    const project = projectOf(`
/** Documented. */
public class Coverage {
    /** Documented. */
    public void a() {}
    public void b() {}
}
`);

    const { coverage } = validateProject(project);
    assert.deepEqual(coverage.types, { documented: 1, total: 1 });
    assert.deepEqual(coverage.members, { documented: 1, total: 2 });
});

// ---------------------------------------------------------------------------
// Annotate
// ---------------------------------------------------------------------------

const UNDOCUMENTED = `public class Todo {
    private Integer count = 0;

    /**
     * Adds one.
     *
     * @param step Amount to add.
     */
    public Integer add(Integer step, Boolean twice) {
        return count;
    }

    public void reset() {}
}
`;

test('inserts stubs and completes existing comments', () => {
    const result = annotateSource(UNDOCUMENTED, 'Todo.cls');

    assert.ok(result.output.includes('/** TODO: describe count. */'));
    assert.ok(result.output.includes(' * TODO: describe Todo.'));
    assert.ok(result.output.includes(' * @param twice TODO'));
    assert.ok(result.output.includes(' * @return TODO'));
    // The tags are added to the comment that is already there, not a new one.
    assert.equal(result.output.match(/Adds one\./g)?.length, 1);
    assert.ok(result.output.includes('@param step Amount to add.'));

    const kinds = result.changes.map((change) => change.kind);
    assert.ok(kinds.includes('added'));
    assert.ok(kinds.includes('completed'));
});

test('annotating twice changes nothing the second time', () => {
    const once = annotateSource(UNDOCUMENTED, 'Todo.cls').output;
    const twice = annotateSource(once, 'Todo.cls');
    assert.deepEqual(twice.changes, []);
    assert.equal(twice.output, once);
});

test('generated comments are themselves parseable', () => {
    const annotated = annotateSource(UNDOCUMENTED, 'Todo.cls').output;
    const info = parseClass(annotated);

    assert.equal(info.doc?.description, 'TODO: describe Todo.');
    assert.deepEqual(
        info.methods[0].doc?.params.map((p) => p.name),
        ['step', 'twice'],
    );
});

test('preserves CRLF line endings', () => {
    const crlf = UNDOCUMENTED.replace(/\n/g, '\r\n');
    const output = annotateSource(crlf, 'Todo.cls').output;

    assert.ok(output.includes('\r\n'));
    assert.equal(output.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF should remain');
});

test('respects the visibility floor', () => {
    const result = annotateSource(UNDOCUMENTED, 'Todo.cls', {
        ...DEFAULT_ANNOTATE_OPTIONS,
        minVisibility: 'public',
    });

    assert.equal(result.output.includes('describe count'), false, 'private field is skipped');
    assert.ok(result.output.includes('describe reset'), 'public method is annotated');
});

// ---------------------------------------------------------------------------
// File header template
// ---------------------------------------------------------------------------

test('writes a file header above a top-level type', () => {
    const result = annotateSource('public class Header {}\n', 'Header.cls', {
        ...DEFAULT_ANNOTATE_OPTIONS,
        author: 'Justin Jang',
        version: 'June 8, 2020',
    });

    assert.equal(
        result.output.split('\n').slice(0, 5).join('\n'),
        [
            '/**',
            ' * TODO: describe Header.',
            ' * @author Justin Jang',
            ' * @version June 8, 2020',
            ' */',
        ].join('\n'),
    );
});

test('header falls back to the placeholder and today for author and version', () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const output = annotateSource('public class Fallback {}\n', 'Fallback.cls').output;

    assert.ok(output.includes(' * @author TODO'));
    assert.ok(output.includes(` * @version ${today}`));
});

test('a custom header template replaces the built-in one', () => {
    const template = [
        '/**',
        ' * {{description}}',
        ' *',
        ' * @author {{author}}',
        ' * @since {{dateLong}}',
        ' * @group {{kind}} from {{file}}',
        ' */',
    ].join('\n');

    const output = annotateSource('public class Custom {}\n', 'app/Custom.cls', {
        ...DEFAULT_ANNOTATE_OPTIONS,
        headerTemplate: template,
        author: 'Ada',
    }).output;

    assert.ok(output.includes(' * @author Ada'));
    assert.ok(output.includes(' * @group class from app/Custom.cls'));
    assert.match(output, / \* @since [A-Z][a-z]+ \d{1,2}, \d{4}$/m);
    assert.equal(output.includes('@version'), false, 'built-in template not used');
});

test('an unknown placeholder is left visible rather than blanked', () => {
    const output = annotateSource('public class Typo {}\n', 'Typo.cls', {
        ...DEFAULT_ANNOTATE_OPTIONS,
        headerTemplate: '/** {{nmae}} */',
    }).output;

    assert.ok(output.includes('{{nmae}}'));
});

test('the header applies to top-level types only', () => {
    const output = annotateSource(
        'public class Outer {\n    private class Inner {}\n}\n',
        'Outer.cls',
    ).output;

    assert.equal(output.match(/@author/g)?.length, 1, 'only the outer type gets a header');
    assert.ok(output.includes('TODO: describe Inner.'));
});

test('interfaces and enums get the header too', () => {
    for (const source of ['public interface I {}\n', 'public enum E { A }\n']) {
        const output = annotateSource(source, 'T.cls').output;
        assert.ok(output.includes('@author'), source);
    }
});

test('a generated header parses back, @version included', () => {
    const annotated = annotateSource('public class RoundTrip {}\n', 'RoundTrip.cls', {
        ...DEFAULT_ANNOTATE_OPTIONS,
        author: 'Justin Jang',
        version: 'June 8, 2020',
    }).output;

    const info = parseClass(annotated);
    assert.equal(info.doc?.description, 'TODO: describe RoundTrip.');
    assert.equal(info.doc?.author, 'Justin Jang');
    assert.equal(info.doc?.version, 'June 8, 2020');
    assert.deepEqual(info.doc?.unknownTags, [], '@version must not fall through as unknown');
});

test('the built-in template is a well-formed comment', () => {
    assert.ok(DEFAULT_HEADER_TEMPLATE.startsWith('/**'));
    assert.ok(DEFAULT_HEADER_TEMPLATE.endsWith('*/'));
});

test('@version reaches both renderers', () => {
    const project = projectOf(
        '/**\n * A service.\n * @version 2.1.0\n */\npublic class Versioned {}\n',
        'Versioned.cls',
    );

    const md = renderMarkdown(project).find((p) => p.fileName === 'Versioned.md')!;
    assert.ok(md.content.includes('**Version:** 2.1.0'));

    const html = renderHtml(project).find((p) => p.fileName === 'Versioned.html')!;
    assert.ok(html.content.includes('<dt>Version</dt><dd>2.1.0</dd>'));
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const RENDERABLE = `
/**
 * A service.
 * @group Services
 * @see Helper
 */
public class Service {
    /**
     * Finds things.
     *
     * @param term What to look for.
     * @return The things found.
     * @deprecated Use {@link Service} instead.
     */
    public List<Account> find(String term) {
        return null;
    }
}
`;

test('renders Markdown with summary tables and working anchors', () => {
    const pages = renderMarkdown(projectOf(RENDERABLE, 'Service.cls'));
    const index = pages.find((page) => page.fileName === 'README.md')!;
    const page = pages.find((p) => p.fileName === 'Service.md')!;

    assert.ok(index.content.includes('## Services'));
    assert.ok(index.content.includes('[Class Service](Service.md)'));

    assert.ok(page.content.includes('## Method Summary'));
    assert.ok(page.content.includes('## Method Detail'));
    assert.ok(page.content.includes('**Returns:** The things found.'));
    assert.ok(page.content.includes('> **Deprecated.**'));

    // Every summary link must point at a heading that exists on the page.
    const headings = new Set(
        [...page.content.matchAll(/^#{2,6} (.+)$/gm)].map(([, heading]) => slugify(heading)),
    );
    const anchors = [...page.content.matchAll(/\]\(#([^)]+)\)/g)].map(([, anchor]) => anchor);
    assert.ok(anchors.length > 0, 'expected at least one intra-page link');
    for (const anchor of anchors) {
        assert.ok(headings.has(anchor), `dangling anchor #${anchor}`);
    }
});

test('renders an HTML site with a page per type', () => {
    const pages = renderHtml(projectOf(RENDERABLE, 'Service.cls'));
    const names = pages.map((page) => page.fileName);
    assert.deepEqual(names, ['styles.css', 'index.html', 'Service.html']);

    const html = pages[2].content;
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('Method Summary'));
    assert.ok(html.includes('class="deprecated"'));
    // {@link Service} resolves to the type's own page.
    assert.ok(html.includes('href="Service.html"'));
    // Angle brackets in types must be escaped, never emitted raw.
    assert.ok(html.includes('List&lt;Account&gt;'));
    assert.equal(html.includes('<Account>'), false);
});
