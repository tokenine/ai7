# Build a plugin

A plugin is a public GitHub repository, or a folder in one, that gives bots skills, a hosted MCP
server, or both. Rakazo reads the files; it never runs code from the repository.

## Minimal example

The [hello world plugin](https://github.com/elie222/rakazo/tree/main/examples/plugins/hello-world) is a complete plugin you can copy:

```text
hello-world/
├── plugin.json
└── skills/
    └── say-hello/
        └── SKILL.md
```

`plugin.json` follows [Agent Plugins](https://agent-plugins.org):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
  "name": "hello-world",
  "version": "1.0.0",
  "description": "A minimal example plugin with one skill.",
  "author": { "name": "Rakazo" },
  "license": "Apache-2.0",
  "keywords": ["example"]
}
```

`skills/say-hello/SKILL.md` starts with a `name` and a `description` that says when to use it:

```markdown
---
name: say-hello
description: Greet the user by name and suggest one thing to try next. Use when the user says hello or asks what you can do.
---

1. Greet the user by name if you know it.
2. In one sentence, suggest one thing they could ask you to do today.
```

## Manifest

Rakazo looks for the manifest in this order:

| File | Format |
| --- | --- |
| `plugin.json` | Agent Plugins. `$schema` must be the 1.0.0 or 1.1.0 plugin schema |
| `.cursor-plugin/plugin.json` | Cursor plugin |
| `.grok-plugin/plugin.json` | Grok plugin |

`name` is required: up to 64 lowercase letters, digits, dots and hyphens, such as `acme-tickets`.
`version`, `description`, `author` (`name`, `email`, `url`), `homepage`, `repository`, `license`
and `keywords` are optional. Other fields are ignored.

## What a plugin can include

| Path | Becomes |
| --- | --- |
| `skills/<folder>/SKILL.md` | A skill. Text files beside it (`.md`, `.mdx`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`) come along as references |
| `commands/<name>.md` | A skill the user can run as `/<name>`. `$ARGUMENTS` is what they type after it |
| `agents/<name>.md` | A helper skill that hands work to a sub-agent. Needs `name` and `description` frontmatter |
| `mcp.json` (or `.mcp.json` for Cursor and Grok plugins) | Hosted MCP servers |

Skill names must be unique in the plugin and must not match a built-in skill, such as
`interrogate`. Other files, such as a README, are ignored.

## MCP servers

Only hosted servers on public `https://` URLs install. For an Agent Plugins manifest, `mcp.json`
uses the matching schema and each server has only `type` (`streamable-http` or `sse`), `url` and
optional `headers`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
  "mcpServers": {
    "acme": { "type": "streamable-http", "url": "https://mcp.acme.com/mcp" }
  }
}
```

Cursor and Grok plugins may also use `"type": "http"`. Don't put keys or `${...}` placeholders in
the URL or headers: each user signs in to the server after installing, through its OAuth or with
their own key.

## What isn't supported

A plugin with any of these is refused, because it would only install in part:

- Local (`stdio`) MCP servers, which run a command on the host.
- `rules/`, `hooks/`, `automations/` or `.lsp.json`, which only work inside an editor.
- Scripts, binaries or other non-text files in a skill folder.
- Symlinks or submodules in a skill, command, agent, manifest or MCP config.
- More than 200 manifest, MCP, skill, reference, command and agent files, any of them over 100 KB,
  more than 4 MB in total, or a skill with more than 40 reference files or 400 KB of them.

## Test it

In Rakazo, open **Integrations**, choose **+** → **From GitHub**, and paste your repository URL.
For a plugin in a folder, use the folder's URL, such as
`https://github.com/acme/plugins/tree/main/acme-tickets`. The preview lists every skill and
server and anything that was left out.

## Submit it

Send it from [Submit a plugin](https://rakazo.com/plugins/submit/), or with the
[submission API](https://rakazo.com/plugins/submit.md). We review every submission, preview it
the same way an install does, and approve it only when every part installs, it has at least one skill or MCP
server, and its MCP servers are public. Approval lists the commit we checked, so later pushes
reach the marketplace when you submit again.
