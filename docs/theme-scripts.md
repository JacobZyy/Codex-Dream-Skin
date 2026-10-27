# Trusted theme scripts

This fork's client 1.5.22 can carry an optional `theme.js` beside an ordinary theme. This is executable renderer code, with access to Codex's page and chat content. It is intended for explicitly trusted local themes, not silent execution of downloaded artwork. The API is not a sandbox; only grant trust after reviewing the complete script and its source.

## Minimal package contract

- Keep theme schemaVersion 1 and the existing theme.json/theme.css/background files. Opt in with `"script": "theme.js"` in theme.json.
- A script archive requires manifest skinApiVersion 2, capability `theme-script`, minClientVersion >=1.5.22 and a registered `theme.js` entry with exact application/javascript media type, byte count and SHA-256. Other v1 packages stay unchanged. Simplified three-file ZIPs cannot contain scripts.
- theme.js is bounded UTF-8 text, nonempty, at most 6 MiB. It is parsed for syntax in Node but NEVER executed there. Existing ZIP/path/link/hash/atomic staging checks apply to this fixed optional file.
- Script bytes may include the theme's CSS and embedded decorative images. No generalized visual schema, extra asset directory or larger theme JSON is introduced.
- Imports only save. Actual renderer execution also requires a local trust grant for the exact script SHA-256. `injector.mjs --trust-theme-script --theme-dir <reviewed-theme-dir>` records that approval without executing the script. Changed bytes have a different hash and require a new review and grant; an existing grant covers only the original bytes. Trust is local to the machine and is not included in an exported theme.
- Static `--check-payload` may parse an untrusted script but must never execute it. Dynamic apply/watch/reload requires trust. A missing declaration preserves old-theme behavior; unexpected or missing declared script fails clearly.

## Review, trust and apply

Ordinary image/CSS themes need no script or trust step. For a scripted theme:

1. Import its manifest-based ZIP into Saved Themes. Importing does not select it or execute `theme.js`.
2. Open the saved theme's directory and review `theme.js`, its embedded content and any network access. A package hash verifies bytes, not the author's behavior.
3. Run the matching command below from the repository root with its supported Node.js runtime. Replace the example with the absolute directory of the reviewed saved theme. The command records the hash and exits without connecting to Codex or executing the script.
4. Select the theme from the menu bar or tray's Saved Themes menu. Changed script bytes need a new review and grant before they can run.

macOS:

```sh
node macos/scripts/injector.mjs --trust-theme-script --theme-dir "/absolute/path/to/reviewed-theme"
```

Windows:

```powershell
node windows/scripts/injector.mjs --trust-theme-script --theme-dir "C:\path\to\reviewed-theme"
```

The native import/selection controls do not grant script trust. There is no automatic approval for a newly downloaded or updated script. `--check-payload` is a static check and does not substitute for review, trust or a visible apply verification.

## Script interface

theme.js is a function body executed once per renderer theme generation. It receives a single `api` variable:

```js
const panel = document.createElement("div");
panel.setAttribute("aria-hidden", "true");
panel.style.pointerEvents = "none";
document.body.append(panel);
api.onCleanup(() => panel.remove());

// Optionally return a promise. The theme is not confirmed rendered until it resolves.
return loadAndDecodeArtwork(api.signal);
```

API fields: `theme` (normalized metadata), `artUrl` (existing background Blob URL), `root` (document.documentElement), `signal` (AbortSignal), and `onCleanup(function)` (register a disposer). Do not put business actions, messages or network credentials in theme scripts.

The existing renderer owns execution and cleanup. It mounts a script once per theme generation, after the core state and initial styling exist. A missing return is synchronously ready; a returned promise keeps the script loading until fulfillment. Script failures and rejected readiness promises remain observable and make normal apply verification fail, allowing the existing rollback path.

Before replacing/removing a theme, the renderer aborts the signal and runs registered cleanup callbacks once, in reverse registration order. One failed disposer does not prevent the others from running. A callback registered after disposal runs immediately. Register cleanup before asynchronous work and check `signal.aborted` after awaits so a cancelled script cannot add its resources back.

Switching A → B → A cleans up each previous generation and mounts A again. A page reload mounts the current trusted script in the new renderer; Restore aborts it and runs its registered cleanup before removing the core skin. A script author is responsible for registering every owned node, listener, observer, animation, URL and native-style change. The client cannot undo arbitrary unregistered changes made by third-party page code.

## Shared helper interface

`runtime/theme-script.mjs` is generated unchanged into macos/assets and windows/assets and exports:

- `THEME_SCRIPT_NAME`, `MAX_THEME_SCRIPT_BYTES` (6 MiB), `THEME_SCRIPT_MIN_CLIENT_VERSION` (1.5.22).
- `decodeThemeScript(bytes)` -> `{source, sha256}`; canonical stable bytes, fatal UTF-8 and VM syntax parse only.
- `readThemeScript(themeDir)` -> null if absent or `{source,sha256,bytes,stat}` after bounded stable no-follow read.
- `themeScriptTrustPath(platform = process.platform)` -> a script-trust.json file beside the current platform's theme preferences.
- `isThemeScriptTrusted(sha256, {trustFile} = {})` -> boolean with strict bounded registry reads.
- `trustThemeScript(themeDir, {trustFile} = {})` -> `{sha256}`; explicit atomic user grant, never script execution.

Trust registry: exact object `{schemaVersion:1,scripts:[sha256,...]}`, at most128 unique lowercase SHA-256 strings, <=64KiB. Reject links/ambiguous/invalid records; atomically preserve existing grants. It is machine-local state outside uploaded packages.

## Lifecycle implementation boundary

The canonical renderer contains `__DREAM_SKIN_THEME_SCRIPT__`, replaced by the injector with null or `function(api){<validated source>}`. It is never evaluated by the Node loader. The serializable `state.script` status has `state` (loading/ready/error/disposed), `sha256`, and an optional generic error code; `state.hasThemeScript` reflects presence. Expose a `cleanupScript` callback for the existing removal fallback. No second watcher and no theme-specific code in the tool.

Both platforms must include theme.js in declared resource copying, fingerprints, saved replacement, active snapshots/rollback and watcher stamps. A->B->A, reload and restore must replay or remove it correctly. Existing ordinary themes must remain unaffected.

The public upstream client and DreamSkin.cc gallery/Studio do not currently implement this new capability. Use a compatible build from [this fork](https://github.com/JacobZyy/Codex-Dream-Skin); the [fork's Releases page](https://github.com/JacobZyy/Codex-Dream-Skin/releases) is the source of truth for available installers. Local implementation, trusted installation and tests do not imply a public release or online support for executable theme packages. Older clients must reject a package requiring Skin API 2 / client 1.5.22 rather than claim a partially applied result.
