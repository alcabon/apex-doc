#!/usr/bin/env node
/**
 * Packs the package and installs it the way a consumer would.
 *
 * This catches the failures that only show up after `npm publish` — a broken
 * `bin`, a missing shebang, an `exports` map that does not resolve — at a point
 * where they are still fixable. A published name@version is permanent, so the
 * rehearsal is worth the thirty seconds.
 *
 *   npm run verify:package              install into a throwaway local project
 *   npm run verify:package -- --global  also rehearse `npm install -g`
 *
 * Everything lands in .tmp/verify/, which is gitignored. Nothing outside the
 * repo is touched unless --global is passed, and that is always undone.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.tmp', 'verify');
const CONSUMER = path.join(WORK, 'consumer');
const REHEARSE_GLOBAL = process.argv.includes('--global');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// npm names the shim `apexdoc.cmd` on Windows and `apexdoc` everywhere else.
const BIN = Object.keys(pkg.bin ?? {})[0];
const SHIM = process.platform === 'win32' ? `${BIN}.cmd` : BIN;

/** Runs a command, returning stdout. Throws — and so fails the script — on a non-zero exit. */
function capture(command, cwd = ROOT) {
    return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function step(message) {
    process.stdout.write(`\n→ ${message}\n`);
}

function detail(message) {
    process.stdout.write(`  ${message}\n`);
}

/** Quotes a path so it survives cmd.exe and sh alike. */
function q(value) {
    return `"${value}"`;
}

function packTarball() {
    step('building and packing');
    capture('npm run build');

    // --json reports the real filename, so the version never has to be guessed
    // here and this keeps working across `npm version`.
    const output = capture(`npm pack --json --pack-destination ${q(WORK)}`);
    const [info] = JSON.parse(output.slice(output.indexOf('[')));

    detail(`${info.filename}  ${(info.size / 1024).toFixed(1)} kB, ${info.entryCount} files`);
    return path.join(WORK, info.filename);
}

function installConsumer(tarball) {
    step('installing into a clean consumer project');

    fs.mkdirSync(CONSUMER, { recursive: true });
    fs.writeFileSync(
        path.join(CONSUMER, 'package.json'),
        `${JSON.stringify({ name: 'apexdoc-consumer', version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
    );

    capture(`npm install ${q(tarball)} --no-audit --no-fund`, CONSUMER);
    detail(`${pkg.name} installed from the tarball`);
}

function checkBin() {
    step(`running the ${BIN} command through its shim`);

    const shim = path.join(CONSUMER, 'node_modules', '.bin', SHIM);
    if (!fs.existsSync(shim)) {
        throw new Error(`no bin shim at ${shim} — check the "bin" field and the shebang`);
    }

    const help = capture(`${q(shim)} --help`, CONSUMER);
    detail(help.split('\n')[0]);

    // Drive it over the real examples, proving file discovery and rendering
    // work from an installed copy rather than only from the source tree.
    const out = path.join(WORK, 'out');
    const generated = capture(
        `${q(shim)} generate ${q(path.join(ROOT, 'examples'))} -o ${q(out)} -f html,md`,
        CONSUMER,
    );
    detail(generated.trim().split('\n').filter(Boolean).pop());
}

function checkEntryPoint() {
    step('importing the package entry point');

    const probe = path.join(CONSUMER, 'probe.mjs');
    fs.writeFileSync(
        probe,
        `import * as api from ${JSON.stringify(pkg.name)};

const file = api.parseApexSource(
    '/** @description Hi. */\\npublic class A { public void b() {} }',
    'A.cls',
);
const project = { title: 'T', files: [file], types: file.declarations };

console.log(JSON.stringify({
    exports: Object.keys(api).length,
    parsed: file.declarations[0].name,
    description: file.declarations[0].doc.description,
    pages: api.renderHtml(project).length,
}));
`,
    );

    const result = JSON.parse(capture(`node ${q(probe)}`, CONSUMER));
    if (result.description !== 'Hi.') {
        throw new Error(`entry point resolved but misbehaved: ${JSON.stringify(result)}`);
    }
    detail(`${result.exports} exports, parsed ${result.parsed}, rendered ${result.pages} pages`);
}

/**
 * The one step that reaches outside the repo. Opt-in, and undone in a finally
 * so a failure mid-way cannot leave a stray global install behind.
 */
function rehearseGlobalInstall(tarball) {
    step(`rehearsing npm install -g ${pkg.name}`);

    capture(`npm install -g ${q(tarball)}`);
    try {
        // Run from outside the repo so this proves PATH resolution, not a
        // relative path that happens to work.
        const help = capture(`${BIN} --help`, path.parse(ROOT).root);
        detail(help.split('\n')[0]);
        detail('global command resolves from outside the project');
    } finally {
        capture(`npm uninstall -g ${pkg.name}`);
        detail('uninstalled again — machine left as found');
    }
}

function main() {
    process.stdout.write(`apexdoc package verification\n`);
    detail(`package  ${pkg.name}@${pkg.version}`);
    detail(`workdir  ${path.relative(ROOT, WORK)}`);

    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    const tarball = packTarball();
    installConsumer(tarball);
    checkBin();
    checkEntryPoint();
    if (REHEARSE_GLOBAL) rehearseGlobalInstall(tarball);

    process.stdout.write(`\n${pkg.name}@${pkg.version} verifies. Tarball kept at:\n`);
    process.stdout.write(`  ${path.relative(ROOT, tarball)}\n`);
    if (!REHEARSE_GLOBAL) {
        process.stdout.write(`\nRe-run with --global to also rehearse a global install.\n`);
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`\nverification failed: ${error.message}\n`);
    if (error.stdout) process.stderr.write(`${error.stdout}\n`);
    if (error.stderr) process.stderr.write(`${error.stderr}\n`);
    process.exitCode = 1;
}
