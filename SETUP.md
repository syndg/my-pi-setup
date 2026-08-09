# Setup

Keep this repository in a normal Git checkout, preferably on internal storage, and install it as a local Pi package:

```sh
git clone git@github.com:syndg/my-pi-setup.git ~/Coding/my-pi-setup
cd ~/Coding/my-pi-setup
npm ci
npm --prefix extensions/hashline ci --omit=dev --omit=peer
pi install "$PWD"
pi config
```

The local package points directly at this checkout; Pi does not copy it. Use `pi config` for global per-extension controls (`pi config -l` for project overrides), and use `/reload` after source or configuration changes. Do not also copy these extensions into `~/.pi/agent/extensions`, because duplicate entrypoints would load twice.

The Hashline extension keeps its runtime diff dependency in its own package, so the second install command is required. `--omit=peer` is mandatory: Hashline must use the host's Pi packages so its mutation queue is shared with built-in tools.

### Hashline rollback

1. Remove or disable the paired Hashline extension/package; never leave only one override enabled.
2. Restart Pi (or reload extensions).
3. Start a new session so historical Hashline calls and guidance are not mixed with built-ins.
4. Re-read files before editing. Pi's built-in `read` and `edit` return together as a pair.

## Firecrawl

The search, scrape, and crawl tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/Coding/my-pi-setup/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the firecrawl extension in their pi setup

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load enabled extensions, skills, and themes from the registered local package the next time it starts.
