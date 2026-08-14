/** Discovering and loading `.cls` files into a {@link Project}. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseApexSource } from './extractor.js';
import type { ApexFile, ClassInfo, Project, TypeDeclaration, Visibility } from './model.js';
import { isVisibleAtLeast } from './model.js';

const APEX_EXTENSIONS = ['.cls'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.sfdx', '.sf', 'dist', 'out']);

/** Every `.cls` under `root`, or `root` itself when it is a file. */
export function findApexFiles(root: string): string[] {
    const stats = fs.statSync(root);
    if (stats.isFile()) return [path.resolve(root)];

    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
            } else if (APEX_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                found.push(full);
            }
        }
    };
    walk(path.resolve(root));
    return found.sort();
}

/** Base directory used to build the relative paths shown in reports. */
function baseOf(root: string): string {
    const resolved = path.resolve(root);
    return fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
}

export function loadFile(filePath: string, base: string): ApexFile {
    const source = fs.readFileSync(filePath, 'utf8');
    const relative = path.relative(base, filePath).split(path.sep).join('/');
    return parseApexSource(source, filePath, relative || path.basename(filePath));
}

/** Parses every Apex file under the given roots. */
export function loadProject(roots: string[], title: string): Project {
    const files: ApexFile[] = [];

    for (const root of roots) {
        const base = baseOf(root);
        for (const filePath of findApexFiles(root)) {
            files.push(loadFile(filePath, base));
        }
    }

    const types = files
        .flatMap((file) => file.declarations)
        .sort((a, b) => a.name.localeCompare(b.name));

    return { title, files, types };
}

/**
 * Drops everything less visible than `minimum`, the way `javadoc -protected`
 * does. Top-level types are always kept so the file itself stays listed.
 */
export function filterByVisibility(project: Project, minimum: Visibility): Project {
    const keep = <T extends { visibility: Visibility }>(item: T): boolean =>
        isVisibleAtLeast(item.visibility, minimum);

    const prune = (decl: TypeDeclaration): TypeDeclaration => {
        if (decl.kind !== 'class') return decl;
        const pruned: ClassInfo = {
            ...decl,
            constructors: decl.constructors.filter(keep),
            methods: decl.methods.filter(keep),
            properties: decl.properties.filter(keep),
            fields: decl.fields.filter(keep),
            innerTypes: decl.innerTypes.filter(keep).map(prune),
        };
        return pruned;
    };

    const files = project.files.map((file) => ({
        ...file,
        declarations: file.declarations.map(prune),
    }));

    return {
        ...project,
        files,
        types: files.flatMap((file) => file.declarations).sort((a, b) => a.name.localeCompare(b.name)),
    };
}
