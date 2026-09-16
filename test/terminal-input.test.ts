import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalMouseInput } from '../src/sessions/session.js';

test('terminal input distinguishes mouse reports from arrow keys and text', () => {
  assert.equal(isTerminalMouseInput('\u001b[<64;10;5M'), true, 'SGR wheel report');
  assert.equal(isTerminalMouseInput('\u001b[M`**'), true, 'legacy X10 mouse report');
  assert.equal(isTerminalMouseInput('\u001b[64;10;5M'), true, 'urxvt mouse report');
  assert.equal(isTerminalMouseInput('\u001b[A'), false, 'Arrow Up');
  assert.equal(isTerminalMouseInput('\u001b[B'), false, 'Arrow Down');
  assert.equal(isTerminalMouseInput('echo hello\r'), false, 'ordinary shell input');
});
