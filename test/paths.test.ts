import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkingDirectory } from '../src/paths.js';

test('working directory normalization resolves native paths', () => { assert.equal(normalizeWorkingDirectory('.'), process.cwd()); });
test('working directory normalization converts Windows drives when hosted on Linux', { skip: process.platform === 'win32' }, () => { assert.equal(normalizeWorkingDirectory('C:\\Users\\Admin\\Code'), '/mnt/c/Users/Admin/Code'); });
