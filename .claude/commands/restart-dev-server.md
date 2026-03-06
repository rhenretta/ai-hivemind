# Restarting the Dev Server

> How to restart the dev server when config, scripts, or environment changes require it.

Use this workflow whenever you make changes that require a full process restart (as opposed to hot-reload). `tsx watch` reloads on file saves, but it does **NOT** re-process `--env-file`, changed npm scripts, or `turbo.json`.

## When a Restart Is Required

A restart is always required when any of the following change:

| Change | Why restart needed |
|---|---|
| `package.json` `scripts` | Running process uses the old command string |
| `turbo.json` `globalEnv` | Turborepo reads this at launch, not dynamically |
| `--env-file` flag added/changed | tsx bakes env vars at process start |
| New npm dependency added | Module resolution happens at process start |
| `.env.local` values changed during a session | Already-loaded lazy singletons (e.g. OpenAI client) won't re-init |

File edits to `.ts` files **do NOT** require a restart — `tsx watch` handles those automatically.

## Steps

1. **Kill all running dev processes**

```bash
pkill -f "turbo run dev" 2>/dev/null
pkill -f "tsx.*index.ts" 2>/dev/null
pkill -f "next.*dev" 2>/dev/null
sleep 2
```

2. **Start turbo dev in the background**

```bash
cd /path/to/ai-hivemind
pnpm turbo run dev > /tmp/turbo-dev.log 2>&1 &
echo "Started PID: $!"
```

3. **Wait for the server to be ready** (allow ~10s for tsx compile + Next.js bootstrap)

```bash
sleep 10
curl -s http://localhost:3001/health
```

A `{"status":"ok",...}` response confirms the backend is live.

4. **Verify env vars loaded correctly**

```bash
# Check that OPENAI_API_KEY reached the process
curl -s http://localhost:3001/health | grep -q "ok" && echo "Server up"
# Then inject a test command and watch /tmp/turbo-dev.log for [LLM] lines
```

5. **Tail the log for errors**

```bash
tail -f /tmp/turbo-dev.log
```

## Self-Management Rule

> **You (Claude Code) are responsible for restarting the dev server** whenever a change requires it.
> Do NOT ask the user to restart — execute the kill + start sequence yourself immediately after making the relevant change.
> Always confirm with a `/health` check before reporting that the fix is live.
