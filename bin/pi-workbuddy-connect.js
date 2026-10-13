#!/usr/bin/env node
// pi-workbuddy-connect — S3 read-only CLI entry point.
// MIT (c) 2026 annacomnena. Net-clean implementation; see THIRD-PARTY-NOTICES.md.
import { runCli } from '../src/cli.js';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
