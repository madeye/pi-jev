# Installing pi-jev into Pi

`pi-jev` is a [Pi package](https://github.com/earendil-works/pi-mono/blob/main/docs/packages.md)
that exposes one extension: `./src/index.ts` (declared under the `pi` key in `package.json`).
Pi loads it directly, so no build step is required.

## Requirements

- Node.js 22 or newer (`node --version`).
- Pi `@earendil-works/pi-coding-agent` 0.85.x. Older `@mariozechner` releases are not tested.
- The workspace default model is `opencode-go/deepseek-v4.1-flash`, configured as
  `defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`. Any configured model works;
  the extension does not configure or download models.
- Optional: a `TYPESAFE_API_KEY` for hosted Jev ranking. Without it, `jev_search`
  still works using local retrieval and no network requests are made.

## Install dependencies

From the checkout:

```sh
npm ci
```

This installs `tsx`, `typescript`, and the pinned Pi version used by the tests and benchmarks.
It is not needed just to load the extension, but it is needed to run `npm test` and `npm run lint`.

## Option 1 — Try it for one session (`-e`)

Load the extension file for a single Pi run without changing any settings:

```sh
pi -e ./src/index.ts --model opencode-go/deepseek-v4.1-flash
```

- `-e` accepts a file or a directory and can be repeated.
- `opencode-go/deepseek-v4.1-flash` is the workspace default model, so `--model` may be omitted.
- Use your own configured provider/model id; the extension does not configure or download models.
- Nothing is written to settings, so the extension disappears when the process exits.

To set the hosted key for that run:

```sh
TYPESAFE_API_KEY=... pi -e ./src/index.ts --model opencode-go/deepseek-v4.1-flash
```

## Option 2 — Install a local checkout persistently

Register this checkout with Pi's global settings (`~/.pi/agent/settings.json`):

```sh
# from inside the checkout
pi install "$(pwd)"
```

Use a relative path if you prefer; Pi resolves it against the settings file that stores it:

```sh
pi install ./pi-jev
```

Confirm it is registered:

```sh
pi list
```

Pi discovers `./src/index.ts` through the package `pi` manifest. To check the extension is
active, start Pi and run `/jev status`; the status bar shows `Jev: on` when a key is set and
`Jev: off` otherwise.

### Install for a single project instead

Use `-l` to write to the project's `.pi/settings.json` instead of the global settings.
Project settings can be committed and shared with a team:

```sh
cd /path/to/project
pi install -l /absolute/path/to/pi-jev
```

If Pi reports `Project is not trusted`, add `--approve` (`-a`) or trust the project. The same
flag is needed to list or remove project-local packages:

```sh
pi install -l -a /absolute/path/to/pi-jev
pi list --approve
pi remove -l -a /absolute/path/to/pi-jev
```

## Option 3 — Install from git (pinned ref)

Install from a repository, pinned to a tag or commit:

```sh
pi install git:github.com/madeye/pi-jev@v0.1.0
# or an explicit URL
pi install https://github.com/madeye/pi-jev@v0.1.0
```

Pi clones the repo under `~/.pi/agent/git/...` (or `.pi/git/...` for `-l`) and runs
`npm install` when a `package.json` is present. Pinned refs are not moved by updates, but
`pi update --extensions` reconciles the existing clone to the configured ref.

## Option 4 — Install from npm (after publishing)

The published package exposes the same `pi` manifest:

```sh
pi install npm:@your-scope/pi-jev@0.1.0
```

To publish it yourself, remove `"private": true` from `package.json`, add the
`pi-package` keyword (already present) and a version, then `npm publish`.

## Configure the hosted key

The extension reads `TYPESAFE_API_KEY` from the environment at load time. Export it in your
shell profile so every Pi session inherits it:

```sh
export TYPESAFE_API_KEY="..."
```

## Verify, update, and remove

```sh
pi list                      # packages from user and project settings
pi list --approve            # include project settings when the project is not trusted
pi config                    # enable/disable individual resources (Tab switches global/project)
pi update --extensions       # update git/npm packages and reconcile pinned refs
pi remove /absolute/path/to/pi-jev
pi remove -l -a /absolute/path/to/pi-jev   # remove a project-local install
```

Inside a running session, use the `/jev` command:

```text
/jev status
/jev find How are retries handled? -- ["docs/network.md", "src/client.ts"]
/jev off
/jev on
```

## Troubleshooting

- **`/jev status` shows `Jev: off`** — no `TYPESAFE_API_KEY` was visible to the Pi process.
  Export it in the same shell that launches `pi`, or pass it inline.
- **The extension does not appear in `pi list`** — a project-local install is hidden until the
  project is trusted; run `pi list --approve`, or check the global scope without `-l`.
- **A local path stopped working** — relative local paths are resolved against the settings
  file. Re-run `pi install "$(pwd)"` from the checkout, or use an absolute path.
- **`npm ci` fails on Node < 22** — upgrade Node; the package sets `"engines": { "node": ">=22" }`.
- **Hosted calls time out** — the runtime deadline is 1.5 s for retrieval and 3 s for adaptive
  routing. A failed hosted call falls back to local retrieval and an explicit failure status;
  see [VALIDATION.md](../VALIDATION.md).
