import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { getCurrentWindowsUserSid, getWindowsSystemExecutable } from '../src/storage/private-file-permissions.js';

export function assertPrivateFilePermissions(filePath) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600, 'private persistence files must have POSIX mode 0600');
    return;
  }

  const acl = execFileSync(getWindowsSystemExecutable('icacls.exe'), [filePath], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const userSid = getCurrentWindowsUserSid().slice(1);
  const userName = execFileSync(getWindowsSystemExecutable('whoami.exe'), [], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const hasCurrentUser = acl.toLowerCase().includes(userSid.toLowerCase()) || acl.toLowerCase().includes(userName.toLowerCase());
  assert.ok(hasCurrentUser, `private ACL should grant the current user access: ${acl}`);
  assert.match(acl, /(?:\*?S-1-5-18|NT AUTHORITY\\SYSTEM):\(F\)/i, `private ACL should retain LocalSystem full control: ${acl}`);
  assert.doesNotMatch(acl, /\(I\)/, `private ACL must not inherit permissions from a broader parent: ${acl}`);
  assert.doesNotMatch(acl, /(?:Everyone|S-1-1-0|BUILTIN\\Users|S-1-5-32-545)/i, `private ACL must not grant broad Users/Everyone access: ${acl}`);
  assert.ok((acl.match(/\(F\)/g) || []).length >= 2, `private ACL should grant full control only to the current user and LocalSystem: ${acl}`);
}
