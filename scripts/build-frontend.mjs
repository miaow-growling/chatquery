#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

const result = spawnSync('npm', ['run', 'build'], {
  cwd: FRONTEND_DIR,
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 0);
