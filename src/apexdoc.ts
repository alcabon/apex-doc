#!/usr/bin/env node
/** Executable entry point: `node dist/apexdoc.js <command> ...` */

import { main } from './apexdoc/cli.js';

process.exitCode = main(process.argv.slice(2));
