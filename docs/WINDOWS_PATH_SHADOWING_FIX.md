# Windows PATH-shadowing fix

## Observed failure

The Windows test log showed `whoami.exe /user /fo csv /nh` returning:

```text
whoami: extra operand '/user'
Try 'whoami --help' for more information.
```

That message is characteristic of a Unix-style `whoami` utility, not the Windows `whoami.exe` command. A Git/MSYS/Cygwin utility earlier on `PATH` was being selected by name. WorkRelay then failed closed because it could not obtain the current Windows user SID, causing private persistence operations and dependent integration tests to fail.

## Correction

`src/storage/private-file-permissions.js` now resolves the supported security utilities from `%SystemRoot%\\System32` using Windows path semantics. It does not search `PATH` for either `whoami.exe` or `icacls.exe`.

`test-support/assert-private-file.js` uses the same resolver when inspecting ACLs. The resolver accepts only the two required executable names and fails closed when no SystemRoot is available.

## Regression coverage

`test/private-file-permissions.test.js` verifies that:

- `whoami.exe` resolves to the Windows System32 directory;
- `icacls.exe` resolves to the Windows System32 directory;
- arbitrary executable names are rejected;
- a missing SystemRoot does not cause a fallback to PATH.

## Validation

The complete Node test suite passed in the available Linux environment: **176 passed, 0 failed, 0 skipped**. This validates the portable path resolver tests and existing POSIX behavior. It does not execute the Windows ACL branch. Run `npm test` on native Windows to complete that platform-specific confirmation.
