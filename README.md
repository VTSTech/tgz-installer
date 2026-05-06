# @vtstech/pi-tgz-installer

A [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent) extension that lets you install Pi packages from `.tgz` URLs or local files.

Pi natively supports installing from npm, git, and local paths — but not `.tgz` tarballs. This extension bridges that gap, reading each package's `pi` manifest and placing resources into Pi's auto-discovery directories.

## Install

```
pi install npm:@vtstech/pi-tgz-installer
```

After installing, run `/reload` to activate.

## Usage

### /tgz-install command

Install a package from a GitHub raw URL:

```
/tgz-install https://github.com/VTSTech/pi-coding-agent/raw/main/dist/pi-security-1.2.3.tgz
```

Install from a local file:

```
/tgz-install ./pi-security-1.2.3.tgz
```

### tgz_install tool (LLM-callable)

The LLM can invoke `tgz_install` directly with a `source` parameter (URL or file path). This is useful for agent workflows where the AI manages package installation automatically.

## How it works

1. Downloads (or reads) the `.tgz` file
2. Extracts it to a temp directory
3. Reads the `package.json` and its `"pi"` manifest
4. Copies resources to the appropriate Pi auto-discovery directories:

| Manifest key | Target directory |
|---|---|
| `extensions` | `~/.pi/agent/extensions/<name>/` |
| `themes` | `~/.pi/agent/themes/<name>/` |
| `skills` | `~/.pi/agent/skills/<name>/` |
| `prompts` | `~/.pi/agent/prompts/<name>/` |

5. The `package.json` is copied into each target subdirectory so Pi can resolve `"type": "module"` and peer dependencies

No `settings.json` modification is needed — Pi auto-discovers files in these directories. Installed packages can be removed like any other Pi package (e.g., `pi remove` or manual deletion from the directories above).

## Requirements

- Pi Coding Agent >= 0.66
- System `tar` command (for extracting `.tgz` files)

## License

MIT
