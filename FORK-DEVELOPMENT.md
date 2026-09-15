# Developing this fork

This repository is a development fork of [duanxianpi/zotflow](https://github.com/duanxianpi/zotflow). The default branch is `master`. It starts from ZotFlow 1.6.5 and retains the upstream plugin ID, settings format, and AGPL-3.0 license.

## Included reader fix

Obsidian 1.14.1 [replaced MathJax 3 with MathJax 4.1.3](https://obsidian.md/changelog/2026-09-08-desktop-v1.14.1/). ZotFlow's reader still creates the old MathJax global configuration and loads `/lib/mathjax/tex-chtml-full.js`. The bundled MathJax code then throws `MathJax.loader.preLoad is not a function` before the reader handshake, which appears as `Child connect timeout`.

`patchReaderHTML()` in `src/bundle-assets/patch-inlined-assets.ts` removes that obsolete host setup. `src/bundle-assets/inline-assets.ts` applies it while unpacking `reader.html`, before creating its Blob URL. The reader continues to use its own bundled math renderer.

The reader submodule stays pinned to upstream. The fix lives in this repository, so it survives rebuilding without maintaining a second fork. The regression test uses the actual submodule template and exercises startup with MathJax 3, MathJax 4, and no host MathJax. Revisit the compatibility patch and test when updating the reader submodule.

## Checkout and dependencies

Install Git for Windows and Node.js 22 or newer. A full build downloads the PDF.js dependencies, pinned Zotero resources, and reader dependencies.

```powershell
git clone --recurse-submodules https://github.com/jr-xing/zotflow.git
cd zotflow
git remote add upstream https://github.com/duanxianpi/zotflow.git
npm ci
```

The existing checkout at `C:\Users\remus\Documents\Projects\zotflow` already has `origin` pointing to this fork and `upstream` pointing to the original repository. Pushes default to `origin`.

If submodules have not been initialized:

```powershell
git submodule update --init --recursive
```

## Build on Windows

The upstream PDF.js build uses Bash. From PowerShell, pass Git Bash as npm's script shell:

```powershell
npm --script-shell="C:\Program Files\Git\bin\bash.exe" run build:ci
```

This builds PDF.js, the embedded reader, and the plugin. Build outputs are `main.js`, `manifest.json`, and `styles.css` in the repository root.

After the first full build, changes to the plugin's `src/` directory only need:

```powershell
npm run build:plugin
```

For continuous plugin rebuilding:

```powershell
npm run dev:plugin
```

`dev:plugin` updates the local build artifact; copy it to a development vault and reload ZotFlow to use it. Reader changes require rebuilding the reader too.

## Tests

```powershell
npm run test:vitest -- tests/unit/reader-html-compatibility.test.ts tests/integration/reader-bridge.test.ts
npm run typecheck:tests
npm run lint
```

`npm test` runs the full lint, test typecheck, and Vitest suite. Some full-suite tests download CSL fixtures on their first run.

## Try a build in a development vault

The plugin ID is still `zotflow`, so this build replaces ZotFlow in whichever vault receives it. Use a separate test vault for unfinished features.

```powershell
$testPluginDir = 'C:\path\to\TestVault\.obsidian\plugins\zotflow'
New-Item -ItemType Directory -Force -Path $testPluginDir
Copy-Item -LiteralPath main.js,manifest.json,styles.css -Destination $testPluginDir
obsidian vault=TestVault plugin:reload id=zotflow
```

For a first install, enable ZotFlow in the test vault's Community plugins settings. Back up an existing installation before replacing its build files. A community plugin update can overwrite a custom build.

## Add a feature

Read `AGENTS.md` for the architecture and repository conventions, then create a branch:

```powershell
git switch master
git switch -c feature/my-feature
```

- Reader integration: `src/ui/reader/`
- Settings and defaults: `src/settings/`
- Zotero sync and worker services: `src/worker/services/`
- Source notes and templates: `src/worker/services/` and `src/utils/`
- Tests: `tests/unit/` and `tests/integration/`

Build, run the relevant tests, and try the feature in the test vault before pushing:

```powershell
git add <changed-files>
git commit -m "feat: describe the new behavior"
git push -u origin feature/my-feature
```

To bring in upstream changes, start with a clean working tree:

```powershell
git switch master
git fetch upstream
git merge upstream/master
git submodule update --init --recursive
npm ci
```

Rebuild and test before pushing `master`. Do not reset the branch to upstream, because that would discard this fork's commits.

## Releases and BRAT installation

Fork releases start at `1.6.6`. In BRAT, add `jr-xing/zotflow` to install this fork with the MathJax compatibility fix. Obsidian 1.13.4 or newer is required.

For future releases, bump the version with `npm version <version> --no-git-tag-version`, commit the updated package and manifest files, and push a tag matching the version exactly (no `v` prefix). The Release workflow builds the plugin and creates a draft with `main.js`, `manifest.json`, and `styles.css`. Check those assets and publish the draft so BRAT can install it.
