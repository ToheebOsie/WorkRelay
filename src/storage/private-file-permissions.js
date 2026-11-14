import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { win32 } from 'node:path';

const SYSTEM_SID = '*S-1-5-18';
const WINDOWS_SYSTEM_EXECUTABLES = new Set(['whoami.exe', 'icacls.exe']);
let cachedWindowsUserSid;

/**
 * Resolve security utilities from the Windows system directory, never PATH.
 * This avoids accidentally invoking Git/MSYS/Cygwin utilities with the same
 * executable name (for example, a Unix `whoami.exe` that rejects `/user`).
 */
export function getWindowsSystemExecutable(name, systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows') {
  if (!WINDOWS_SYSTEM_EXECUTABLES.has(name)) {
    throw new TypeError(`Unsupported Windows system executable: ${name}`);
  }
  if (typeof systemRoot !== 'string' || !systemRoot.trim()) {
    throw new Error('Windows SystemRoot is unavailable; refusing to resolve a security utility through PATH.');
  }
  return win32.join(systemRoot, 'System32', name);
}

function getWindowsUserSid() {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  let identity;
  try {
    identity = execFileSync(getWindowsSystemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new Error('Unable to determine the current Windows user SID; refusing to persist private WorkRelay state without a restrictive ACL.', { cause: error });
  }
  const sid = identity.match(/\bS-\d-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('The current Windows user SID could not be parsed; refusing to persist private WorkRelay state.');
  cachedWindowsUserSid = `*${sid}`;
  return cachedWindowsUserSid;
}

/**
 * Apply owner-only persistence permissions using the native permission model.
 * POSIX uses mode 0600. Windows uses an explicit NTFS DACL for the current
 * user and LocalSystem, with inherited ACEs removed. Failure is fail-closed.
 */
export function securePrivateFileSync(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('A file path is required to secure private persistence.');

  if (process.platform === 'win32') {
    const userSid = getWindowsUserSid();
    try {
      execFileSync(getWindowsSystemExecutable('icacls.exe'), [
        filePath,
        '/inheritance:r',
        '/grant:r',
        `${userSid}:F`,
        `${SYSTEM_SID}:F`,
        '/Q'
      ], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      const detail = [error.message, error.stderr?.toString?.()].filter(Boolean).join(' ');
      throw new Error(`Unable to apply a private Windows ACL to WorkRelay persistence file "${filePath}": ${detail}`, { cause: error });
    }
    return;
  }

  chmodSync(filePath, 0o600);
}

export const getCurrentWindowsUserSid = getWindowsUserSid;
