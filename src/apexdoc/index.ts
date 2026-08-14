/**
 * Public API.
 *
 * The CLI is one consumer of this module; anything it can do is available
 * programmatically:
 *
 * ```ts
 * import { loadProject, renderHtml, validateProject } from './apexdoc/index.js';
 *
 * const project = loadProject(['force-app'], 'My Org');
 * const pages = renderHtml(project, validateProject(project));
 * ```
 */

export * from './model.js';
export { parseDocComment, isEmptyDoc, INLINE_LINK_RE } from './doc-comment.js';
export { parseApexSource } from './extractor.js';
export { findApexFiles, loadFile, loadProject, filterByVisibility } from './project.js';
export { validateProject, formatRatio } from './validate.js';
export type { Issue, Severity, Coverage, ValidationResult } from './validate.js';
export { renderMarkdown } from './render-markdown.js';
export { renderHtml } from './render-html.js';
export type { Page } from './render-shared.js';
export {
    annotateSource,
    DEFAULT_ANNOTATE_OPTIONS,
    type AnnotateChange,
    type AnnotateOptions,
    type AnnotateResult,
} from './annotate.js';
export { main as runCli } from './cli.js';
