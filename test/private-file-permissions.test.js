import test from 'node:test';
import assert from 'node:assert/strict';
import { getWindowsSystemExecutable } from '../src/storage/private-file-permissions.js';

test('Windows security utilities resolve from System32 rather than PATH', () => {
  assert.equal(
    getWindowsSystemExecutable('whoami.exe', 'C:\\Windows'),
    'C:\\Windows\\System32\\whoami.exe'
  );
  assert.equal(
    getWindowsSystemExecutable('icacls.exe', 'D:\\Windows'),
    'D:\\Windows\\System32\\icacls.exe'
  );
});

test('Windows security utility resolver rejects arbitrary executables', () => {
  assert.throws(() => getWindowsSystemExecutable('cmd.exe', 'C:\\Windows'), /Unsupported Windows system executable/);
});

test('Windows security utility resolver fails closed without SystemRoot', () => {
  assert.throws(() => getWindowsSystemExecutable('whoami.exe', ''), /SystemRoot is unavailable/);
});
