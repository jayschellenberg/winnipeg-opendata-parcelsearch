// Unit tests for lib/buildStamp.js — the commit + build time printed after
// the page title. SHARED FILE: byte-identical in both apps.
//
// Run: cd web && node test/buildStamp.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildStampText, localStamp } from '../src/lib/buildStamp.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

const iso = new Date(2026, 10, 11, 9, 5).toISOString();   // local 2026-11-11 09:05
assert.equal(localStamp(iso), '2026-11-11 09:05', 'local time, zero-padded');
assert.equal(localStamp('nonsense'), '');
assert.equal(localStamp(null), '');

const s = buildStampText('1dc7566abcdef', iso);
assert.equal(s.text, '1dc7566 · 2026-11-11 09:05', 'short sha and build time');
assert.match(s.title, /1dc7566abcdef/, 'full commit on hover');

assert.equal(buildStampText(null, null).text, 'dev', 'dev server says dev');
assert.equal(buildStampText('unknown', iso).text, '2026-11-11 09:05', 'no git: time alone');

// Wired: the title carries the slot, main.js fills it, the build defines it.
const html = readFileSync(path.join(dir, '../index.html'), 'utf8');
assert.match(html, /class="topbar-title"[^>]*><span class="topbar-title-text">[^<]*<small class="app-build" id="app-build"/, 'stamp slot inside the title');
const main = readFileSync(path.join(dir, '../src/main.js'), 'utf8');
assert.match(main, /showBuildStamp\(\)/, 'main.js fills the stamp');
const vite = readFileSync(path.join(dir, '../vite.config.js'), 'utf8');
assert.match(vite, /__APP_COMMIT__/, 'the build bakes in the commit');
assert.match(vite, /__APP_BUILD_TIME__/, 'the build bakes in the time');

console.log('buildStamp: all tests passed');
