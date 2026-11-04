Unsigned alpha of Reader. No notarization and no Authenticode signature.

## Windows 11 (x64)

1. Download `Reader-windows-x64.exe`.
2. If SmartScreen says it protected your PC, choose **More info**, then **Run anyway**.
3. Windows 11 already includes the WebView2 runtime this build uses.
4. Double-click the exe, or from a terminal run `Reader-windows-x64.exe C:\path\to\file.pdf`.
5. File → Open, or drop a PDF or Markdown file on the window. There is no format prompt.

## Mac (Apple Silicon)

1. Download `Reader-macos-arm64.zip` and unzip it.
2. Move `Reader.app` to Applications if you want.
3. The first open is blocked by Gatekeeper. Right-click `Reader.app` → **Open** → **Open**. If macOS only offers Move to Trash, open **System Settings → Privacy & Security** and click **Open Anyway**.
4. Open a file from the menu, or run `Reader.app/Contents/MacOS/reader /path/to/file`.
5. An Intel zip, when this release includes `Reader-macos-x64.zip`, is the same steps on an Intel Mac.

This build does not phone home. Annotation drawing is not in this alpha. Signing and notarization come later.
