# Plugins

A plugin is an MCP server that every agent on an environment gets, beside T3
Code's own tools. Add it once, and Claude, Codex, Cursor, Grok, Kiro, API chat,
and other ACP agents can all call its tools.

## Add a plugin

Open **Settings → Plugins**.

- **Plugin store**: choose **Add** next to a plugin.
- **Your own**: enter a short name and either the command that starts the
  server, such as `npx -y some-mcp-server`, or the server's URL. A URL plugin
  must work without a sign-in.

Turn a plugin off with its switch, or remove it. A thread picks up a change the
next time its agent starts, such as after the thread sits idle for 30 minutes or
T3 Code restarts. Plugins apply to every project on the environment, and the
program runs on the environment's machine.

Changing plugins needs permission to manage providers, because every agent
starts the plugin's program.

## Computer control (Mac)

**Computer control (Mac)** in the store adds
[Peekaboo](https://github.com/openclaw/Peekaboo/blob/main/docs/MCP.md), which
lets agents see the screen, click, type, and use any app. It needs Node 22 or
newer on the Mac. The first time an agent uses it, macOS asks you to allow
**Screen Recording** and **Accessibility** for the app that runs T3 Code, such
as T3 Code itself or your terminal. Allow both in **System Settings → Privacy &
Security**, then restart that app.

An agent with computer control can do anything you can do on the Mac. Use a
permission mode that asks before tool calls when you want to watch each step.

## Which agents get plugins

- Claude, Codex, Cursor, Grok, Kiro, Antigravity, fx, API chat, and agents
  added from the ACP registry get every plugin. An ACP agent that does not
  accept MCP servers by URL gets only command plugins.
- Muse Code gets URL plugins only.
- OpenCode and Pi do not get plugins yet.
- API chat reads a tool's text result only; an image a tool returns shows as
  `[image content]`.
