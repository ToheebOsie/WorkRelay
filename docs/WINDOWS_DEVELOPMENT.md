# Windows development and test notes

WorkRelay supports Node.js 20 or newer on Windows as well as POSIX development environments.

## Run the test suite

From PowerShell in the repository root:

```powershell
node --version
npm test
```

The dependency-route integration test starts a child WorkRelay server. It uses a `file:` URL for the ESM `--import` mock, resolves the repository working directory to a native filesystem path, obtains an available loopback port from the operating system, and captures child stdout/stderr. If the server does not become ready, the assertion includes the last connection error and child-process diagnostics.

## Private persistence files

Node's `fs` file-mode interface does not implement POSIX owner/group/other permission distinctions on Windows. The three private persistence stores therefore use platform-native enforcement:

- POSIX: files are set to mode `0600`.
- Windows: after writing the temporary file and before the atomic rename, WorkRelay invokes `icacls.exe` to remove inherited ACL entries and grant Full Control only to the current process user SID and LocalSystem (`S-1-5-18`).

The Windows operation is fail-closed. If WorkRelay cannot identify the current user SID or cannot apply the ACL, persistence throws rather than silently treating the file as private. WorkRelay resolves `whoami.exe` and `icacls.exe` directly from `%SystemRoot%\System32` instead of searching `PATH`, avoiding accidental use of Git/MSYS/Cygwin utilities with the same names.

The corresponding tests verify the POSIX mode on POSIX systems. On Windows they inspect the NTFS ACL, confirm the current user and LocalSystem entries, and reject inherited, Everyone or BUILTIN\\Users grants.

## Local simulation mode

These test-compatibility changes do not enable payment or commissioning. Keep the wallet adapter unset, `X402_ALLOWED_NETWORKS` empty and `X402_ALLOWED_ASSETS_JSON` set to `{}` for simulation-only local use. The application health endpoint should continue to report `commissioningConfigured: false` and an empty `paymentNetworks` array.

## Validation limitation

A passing test run on Linux verifies the POSIX code path and the portable child-process test. It does not substitute for executing `npm test` on a native Windows machine. After updating the ZIP on Windows, run `npm test` there and retain the output as the native Windows confirmation.
