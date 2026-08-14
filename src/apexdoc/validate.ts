/**
 * Consistency checks between the code and its documentation, plus the
 * coverage figures reported by `apexdoc check`.
 */

import type {
    ApexDoc,
    Documentable,
    ParameterInfo,
    Project,
    TypeDeclaration,
} from './model.js';
import { membersOf, walkTypes } from './model.js';

export type Severity = 'error' | 'warning';

export interface Issue {
    file: string;
    line: number;
    /** `AccountService.findAccounts` — what the issue is about. */
    target: string;
    rule: string;
    severity: Severity;
    message: string;
}

export interface Coverage {
    types: { documented: number; total: number };
    members: { documented: number; total: number };
}

export interface ValidationResult {
    issues: Issue[];
    coverage: Coverage;
}

function percent(documented: number, total: number): number {
    return total === 0 ? 100 : Math.round((documented / total) * 100);
}

/** `documented/total (xx%)` */
export function formatRatio(documented: number, total: number): string {
    return `${documented}/${total} (${percent(documented, total)}%)`;
}

function parametersOf(member: Documentable): ParameterInfo[] | undefined {
    return member.kind === 'method' || member.kind === 'constructor'
        ? member.parameters
        : undefined;
}

class Validator {
    readonly issues: Issue[] = [];
    documentedTypes = 0;
    totalTypes = 0;
    documentedMembers = 0;
    totalMembers = 0;

    private add(
        member: Documentable,
        file: string,
        target: string,
        rule: string,
        message: string,
        severity: Severity = 'warning',
    ): void {
        this.issues.push({ file, line: member.anchorLine, target, rule, severity, message });
    }

    checkType(decl: TypeDeclaration): void {
        this.totalTypes++;
        if (decl.doc) this.documentedTypes++;

        const target = decl.qualifiedName;
        if (!decl.doc) {
            this.add(decl, decl.file, target, 'missing-doc', `${decl.kind} is undocumented`);
        } else if (!decl.doc.description.trim()) {
            this.add(decl, decl.file, target, 'empty-description', `${decl.kind} has no description`);
        }

        for (const member of membersOf(decl)) {
            this.checkMember(decl, member);
        }
    }

    private checkMember(owner: TypeDeclaration, member: Documentable): void {
        this.totalMembers++;
        if (member.doc) this.documentedMembers++;

        const target = `${owner.qualifiedName}.${member.name}`;
        const file = owner.file;

        if (!member.doc) {
            this.add(member, file, target, 'missing-doc', `${member.kind} is undocumented`);
            return;
        }

        if (!member.doc.description.trim()) {
            this.add(member, file, target, 'empty-description', `${member.kind} has no description`);
        }

        const params = parametersOf(member);
        if (params) this.checkParams(member.doc, params, member, file, target);

        if (member.kind === 'method') {
            const returnsValue = member.returnType !== 'void';
            if (returnsValue && !member.doc.returns) {
                this.add(
                    member,
                    file,
                    target,
                    'missing-return',
                    `missing @return (returns ${member.returnType})`,
                );
            }
            if (!returnsValue && member.doc.returns) {
                this.add(member, file, target, 'spurious-return', 'has @return but returns void');
            }
        }
    }

    private checkParams(
        doc: ApexDoc,
        params: ParameterInfo[],
        member: Documentable,
        file: string,
        target: string,
    ): void {
        const documented = new Set(doc.params.map((p) => p.name));
        const declared = new Set(params.map((p) => p.name));

        for (const param of params) {
            if (!documented.has(param.name)) {
                this.add(member, file, target, 'missing-param', `missing @param ${param.name}`);
            }
        }
        for (const param of doc.params) {
            if (!declared.has(param.name)) {
                this.add(
                    member,
                    file,
                    target,
                    'unknown-param',
                    `@param ${param.name} does not match any parameter`,
                );
            }
        }
    }
}

/** Runs every check over a project. */
export function validateProject(project: Project): ValidationResult {
    const validator = new Validator();

    for (const file of project.files) {
        for (const error of file.errors) {
            validator.issues.push({
                file: file.relativePath,
                line: error.line,
                target: file.relativePath,
                rule: 'parse-error',
                severity: 'error',
                message: error.message,
            });
        }
    }

    for (const decl of project.types) {
        for (const type of walkTypes(decl)) {
            validator.checkType(type);
        }
    }

    validator.issues.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
    );

    return {
        issues: validator.issues,
        coverage: {
            types: { documented: validator.documentedTypes, total: validator.totalTypes },
            members: { documented: validator.documentedMembers, total: validator.totalMembers },
        },
    };
}
