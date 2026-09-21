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
- A judgment server. The default is a self-hosted DiffusionGemma structured-read server on
  `http://127.0.0.1:8011`; hosted Jev is opt-in (see [Judgment server](#judgment-server)).
  With no server reachable, `jev_search` still works using local retrieval.

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

To use hosted Jev for that run:

```sh
TYPESAFE_BASE_URL=https://api.typesafe.ai TYPESAFE_API_KEY=... pi -e ./src/index.ts --model opencode-go/deepseek-v4.1-flash
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
active, start Pi and run `/jev status`; the status bar shows `Jev: on` unless the judgment
server was switched off (`Jev: off`).

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

## Judgment server

**Default: self-hosted DiffusionGemma.** With `TYPESAFE_BASE_URL` unset, the extension sends
judgments to `http://127.0.0.1:8011` and adds `{"samples":1}` to every request. That is the
DiffusionGemma structured-read server from
[vllm-project/vllm#57250](https://github.com/vllm-project/vllm/pull/57250) with the
single-sample reads [VALIDATION.md](../VALIDATION.md) adopted. No key is needed. Run the
server on the same machine, or forward the port from the machine that has it:

```sh
ssh -N -L 127.0.0.1:8011:127.0.0.1:8011 gpu-host
```

**Another self-hosted server.** `TYPESAFE_BASE_URL` takes any server that speaks the same
`POST /v1/systemone` contract. Only `http` and `https` URLs are accepted, and a path prefix is
kept. The default `{"samples":1}` is not sent to it; set `TYPESAFE_REQUEST_EXTENSIONS` if it
wants extensions. If `TYPESAFE_API_KEY` is set it is sent as a bearer token.

```sh
export TYPESAFE_BASE_URL="http://192.168.0.4:8011"
```

**Hosted Jev (opt-in).** Name the hosted service and export its key in your shell profile:

```sh
export TYPESAFE_BASE_URL="https://api.typesafe.ai"
export TYPESAFE_API_KEY="..."
```

An empty `TYPESAFE_BASE_URL=` means no self-hosted server: hosted Jev if a key is set,
otherwise no judgment server at all (the benchmarks use this for their baselines).

Two further settings exist for tuning a self-hosted server; both are read at load time and
reported by `/jev status`, which also shows the server in use:

- `TYPESAFE_REQUEST_EXTENSIONS`: a JSON object of extra top-level request fields the server
  understands, sent with every judgment. The core fields (`model`, `state`, `questions`) cannot
  be overridden. For the DiffusionGemma structured-read server, `{"samples":1}` asks for a
  single denoise read instead of its adaptive re-sampling; see VALIDATION.md for the measured
  effect. It is the default for the default server only. The hosted service needs none.
- `TYPESAFE_CONFIDENCE`: the confidence a judgment needs before it changes anything (skill
  suggestions, condensed excerpts, withheld output), from 0.5 to 1. The default 0.8 was tuned on
  the hosted service's calibrated confidence. Values outside the range are ignored.

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

- **`/jev status` shows `Jev: off`** — `TYPESAFE_BASE_URL` is empty and no `TYPESAFE_API_KEY`
  was visible to the Pi process. Unset the variable for the default server, or export the key
  in the same shell that launches `pi`.
- **Nothing is condensed and `/jev status` counts failures** — the default server on
  `127.0.0.1:8011` is not reachable. Start it or the SSH tunnel, or set `TYPESAFE_BASE_URL`.
- **The extension does not appear in `pi list`** — a project-local install is hidden until the
  project is trusted; run `pi list --approve`, or check the global scope without `-l`.
- **A local path stopped working** — relative local paths are resolved against the settings
  file. Re-run `pi install "$(pwd)"` from the checkout, or use an absolute path.
- **`npm ci` fails on Node < 22** — upgrade Node; the package sets `"engines": { "node": ">=22" }`.
- **Hosted calls time out** — the runtime deadline is 1.5 s for retrieval and 3 s for adaptive
  routing. A failed hosted call falls back to local retrieval and an explicit failure status;
  see [VALIDATION.md](../VALIDATION.md).
