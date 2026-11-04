# Downloadable builds

This directory is not where the Windows and Mac binaries are stored. Those are built on GitHub-hosted runners, because this environment cannot produce a Windows exe or a macOS `.app`.

## Release

<https://github.com/samdharma/reader/releases/tag/v0.1.0>

| File | Who it runs on |
| --- | --- |
| `Reader-windows-x64.exe` | Windows 11, 64-bit. Portable. No installer. |
| `Reader-macos-arm64.zip` | Apple Silicon. Unzip to get `Reader.app`. |
| `Reader-macos-x64.zip` | Intel Mac, when that extra build succeeds. |
| `Reader-linux-x64.AppImage` | Linux x64, when the optional job succeeds. |
| `SHA256SUMS` | Checksums for the files above. |

Direct file URLs, once the release job has finished:

- <https://github.com/samdharma/reader/releases/download/v0.1.0/Reader-windows-x64.exe>
- <https://github.com/samdharma/reader/releases/download/v0.1.0/Reader-macos-arm64.zip>
- <https://github.com/samdharma/reader/releases/download/v0.1.0/SHA256SUMS>

The workflow is `.github/workflows/release.yml`. It runs on every push to `main`, builds on `windows-latest` and `macos-latest`, and uploads the files onto the `v0.1.0` prerelease. The binaries are unsigned. Windows SmartScreen needs **More info → Run anyway**. macOS Gatekeeper needs a right-click **Open**, or **Open Anyway** under Privacy & Security.

How to launch them is in the repository README, under “Download and run”.
