/** Command line front end. See `apexdoc --help` for the contract. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_ANNOTATE_OPTIONS, annotateSource, type AnnotateOptions } from './annotate.js';
import { VISIBILITY_ORDER, type Project, type Visibility } from './model.js';
import { filterByVisibility, findApexFiles, loadProject } from './project.js';
import { renderHtml } from './render-html.js';
import { renderMarkdown } from './render-markdown.js';
import type { Page } from './render-shared.js';
import { formatRatio, validateProject, type Issue } from './validate.js';

type Command = 'generate' | 'annotate' | 'check';
type Format = 'html' | 'md' | 'json';

interface Options {
    command: Command;
    roots: string[];
    out: string;
    formats: Format[];
    access: Visibility;
    /** True when --access was given, so `annotate` knows not to default it. */
    accessExplicit: boolean;
    title: string;
    annotate: AnnotateOptions;
    dryRun: boolean;
    backup: boolean;
    strict: boolean;
}

const USAGE = `apexdoc — ApexDoc/JavaDoc style documentation for Salesforce Apex

Usage:
  apexdoc generate <path...> [options]   Render documentation
  apexdoc annotate <path...> [options]   Insert or complete doc comments in the source
  apexdoc check    <path...> [options]   Report undocumented or inconsistent members

Options:
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
      --doc-version <text> annotate: fills {{version}} (default: today's date)
      --strict             check: exit 1 on warnings as well as errors
  -h, --help               Show this message

The file header written above a top-level type comes from a template. The
built-in one is:

  /**
   * {{description}}
   * @author {{author}}
   * @version {{version}}
   */

Pass --header to use your own. Placeholders: {{name}}, {{qualifiedName}},
{{kind}}, {{file}}, {{description}}, {{author}}, {{version}}, {{date}},
{{dateLong}}, {{year}}, {{placeholder}}. Unknown ones are left as written.

Examples:
  apexdoc generate force-app -o docs -f html
  apexdoc annotate force-app/main/default/classes --dry-run
  apexdoc annotate force-app --author "Justin Jang" --doc-version "June 8, 2020"
  apexdoc annotate force-app --header templates/header.txt
  apexdoc check force-app --access public --strict
`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
    const options: Options = {
        command: 'generate',
        roots: [],
        out: 'apexdocs',
        formats: ['html', 'md'],
        access: 'protected',
        accessExplicit: false,
        title: 'Apex Documentation',
        annotate: { ...DEFAULT_ANNOTATE_OPTIONS },
        dryRun: false,
        backup: false,
        strict: false,
    };

    let index = 0;
    if (argv[0] && !argv[0].startsWith('-')) {
        const command = argv[0];
        if (command !== 'generate' && command !== 'annotate' && command !== 'check') {
            throw new UsageError(`Unknown command: ${command}`);
        }
        options.command = command;
        index = 1;
    }

    const next = (flag: string): string => {
        const value = argv[++index];
        if (value === undefined) throw new UsageError(`${flag} needs a value`);
        return value;
    };

    for (; index < argv.length; index++) {
        const arg = argv[index];
        switch (arg) {
            case '-o':
            case '--out':
                options.out = next(arg);
                break;
            case '-f':
            case '--format':
                options.formats = parseFormats(next(arg));
                break;
            case '-a':
            case '--access':
                options.access = parseVisibility(next(arg));
                options.accessExplicit = true;
                break;
            case '-t':
            case '--title':
                options.title = next(arg);
                break;
            case '--placeholder':
                options.annotate.placeholder = next(arg);
                break;
            case '--header': {
                const file = next(arg);
                try {
                    options.annotate.headerTemplate = fs
                        .readFileSync(file, 'utf8')
                        .replace(/\r?\n$/, '');
                } catch {
                    throw new UsageError(`Cannot read header template: ${file}`);
                }
                break;
            }
            case '--author':
                options.annotate.author = next(arg);
                break;
            // Not `--version`: that conventionally prints the tool's own
            // version, and this fills the @version tag in generated headers.
            case '--doc-version':
                options.annotate.version = next(arg);
                break;
            case '--no-complete':
                options.annotate.completeExisting = false;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--backup':
                options.backup = true;
                break;
            case '--strict':
                options.strict = true;
                break;
            default:
                if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
                options.roots.push(arg);
        }
    }

    if (options.roots.length === 0) throw new UsageError('No input path given');
    // `annotate` rewrites what it is pointed at, so it ignores --access unless
    // the caller narrowed it explicitly.
    return options;
}

function parseFormats(value: string): Format[] {
    return value.split(',').map((raw) => {
        const format = raw.trim().toLowerCase();
        if (format === 'html' || format === 'json') return format;
        if (format === 'md' || format === 'markdown') return 'md';
        throw new UsageError(`Unknown format: ${raw}`);
    });
}

function parseVisibility(value: string): Visibility {
    const level = value.trim().toLowerCase() as Visibility;
    if (!VISIBILITY_ORDER.includes(level)) throw new UsageError(`Unknown access level: ${value}`);
    return level;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function writePages(directory: string, pages: Page[]): void {
    fs.mkdirSync(directory, { recursive: true });
    for (const page of pages) {
        fs.writeFileSync(path.join(directory, page.fileName), page.content, 'utf8');
    }
}

function runGenerate(options: Options): number {
    const project = filterByVisibility(loadProject(options.roots, options.title), options.access);
    const validation = validateProject(project);

    report(project, validation.issues.filter((issue) => issue.severity === 'error'));

    for (const format of options.formats) {
        if (format === 'html') {
            const directory = path.join(options.out, 'html');
            writePages(directory, renderHtml(project, validation));
            console.log(`html      ${path.join(directory, 'index.html')}`);
        } else if (format === 'md') {
            const directory = path.join(options.out, 'markdown');
            writePages(directory, renderMarkdown(project));
            console.log(`markdown  ${path.join(directory, 'README.md')}`);
        } else {
            fs.mkdirSync(options.out, { recursive: true });
            const file = path.join(options.out, 'apexdoc.json');
            fs.writeFileSync(file, JSON.stringify(project, null, 2), 'utf8');
            console.log(`json      ${file}`);
        }
    }

    console.log(
        `\nCoverage  types ${formatRatio(validation.coverage.types.documented, validation.coverage.types.total)}` +
            `  members ${formatRatio(validation.coverage.members.documented, validation.coverage.members.total)}`,
    );
    return 0;
}

function runCheck(options: Options): number {
    const project = filterByVisibility(loadProject(options.roots, options.title), options.access);
    const { issues, coverage } = validateProject(project);

    for (const issue of issues) {
        console.log(
            `${issue.severity === 'error' ? 'ERROR' : 'warn '} ${issue.file}:${issue.line}  ${issue.target}: ${issue.message} [${issue.rule}]`,
        );
    }

    const errors = issues.filter((issue) => issue.severity === 'error').length;
    const warnings = issues.length - errors;

    console.log(
        `\n${project.types.length} type(s) checked — ${errors} error(s), ${warnings} warning(s)`,
    );
    console.log(
        `Coverage  types ${formatRatio(coverage.types.documented, coverage.types.total)}` +
            `  members ${formatRatio(coverage.members.documented, coverage.members.total)}`,
    );

    if (errors > 0) return 1;
    return options.strict && warnings > 0 ? 1 : 0;
}

function runAnnotate(options: Options): number {
    // Unlike the renderers, `annotate` documents everything by default; a
    // private helper still deserves a comment.
    const annotateOptions: AnnotateOptions = {
        ...options.annotate,
        minVisibility: options.accessExplicit ? options.access : 'private',
    };
    let changedFiles = 0;
    let totalChanges = 0;

    for (const root of options.roots) {
        for (const filePath of findApexFiles(root)) {
            const source = fs.readFileSync(filePath, 'utf8');
            const relative = path.relative(process.cwd(), filePath) || path.basename(filePath);
            const result = annotateSource(source, relative, annotateOptions);
            if (result.changes.length === 0) continue;

            changedFiles++;
            totalChanges += result.changes.length;
            console.log(`\n${relative}`);
            for (const change of result.changes) {
                const suffix = change.details.length > 0 ? ` (${change.details.join(', ')})` : '';
                console.log(`  ${change.kind === 'added' ? '+' : '~'} line ${change.line}  ${change.target}${suffix}`);
            }

            if (options.dryRun) continue;
            if (options.backup) fs.copyFileSync(filePath, `${filePath}.bak`);
            fs.writeFileSync(filePath, result.output, 'utf8');
        }
    }

    const verb = options.dryRun ? 'would change' : 'changed';
    console.log(`\n${verb} ${totalChanges} comment(s) across ${changedFiles} file(s)`);
    return 0;
}

function report(project: Project, errors: Issue[]): void {
    console.log(`Parsed ${project.files.length} file(s), ${project.types.length} top-level type(s)`);
    for (const error of errors) {
        console.error(`ERROR ${error.file}:${error.line}  ${error.message}`);
    }
    if (errors.length > 0) console.error('');
}

// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
    if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
        console.log(USAGE);
        return argv.length === 0 ? 1 : 0;
    }

    let options: Options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        console.error(error instanceof UsageError ? `${error.message}\n` : String(error));
        console.error(USAGE);
        return 2;
    }

    try {
        switch (options.command) {
            case 'generate':
                return runGenerate(options);
            case 'annotate':
                return runAnnotate(options);
            case 'check':
                return runCheck(options);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }
}
