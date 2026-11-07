#!/usr/bin/env node
// The `page-edits` command. Its commands are described in receiver.mjs.

import { main } from "./receiver.mjs";

process.exitCode = await main(process.argv.slice(2));
