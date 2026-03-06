---
name: gemini-cli-conductor
description: How to use the Gemini CLI Conductor extension autonomously via the Agent
---
# Gemini CLI Conductor Skill

The Gemini CLI `conductor` extension is used to execute autonomous feature development workflows. The agent bridges user intentions to the Gemini CLI by running a single interactive subprocess. 

**CRITICAL INVARIANTS**:
1. **Never use PTY or Pseudo-Terminals**: The Gemini CLI detects TTYs and drops back to its interactive ratatui-based UI, breaking programmatic automation. 
2. **Always use `--output-format stream-json`**: This is the only way to reliably extract `tool_use`, `plan`, `terminal`, and `result` events from Gemini without complex string-parsing of ANSI codes.
3. **Always use Standard Pipes**: Spawn `gemini` with `stdio: ['pipe', 'pipe', 'pipe']`. Piping `stdin` allows the agent to intercept and dynamically respond to interactive prompts (like `ask_user` confirmations).
4. **Never close stdin prematurely**: Do not call `stdin.end()` until you are ready to terminate the process. Gemini streams progress and may pause to request confirmation via `ask_user`.
5. **Auto-approve with `--yolo`**: Always start the process with `--yolo` to prevent normal permission prompts from locking up the automation.

### Architectural Approach

The system uses a **Single-Spawn Interactive Stream** model:
- The agent spawns **one** `gemini` process for the entire lifecycle using `/conductor:newTrack`.
- The task objective and context are piped into `stdin` upfront.
- As the stream emits JSON objects, the agent parses and bridges them to the Command Center UI.
- When `ask_user` tool calls are emitted for intermediate clarification or the final `/conductor:implement` action, the agent dynamically synthesizes an LLM response and writes it back into `stdin` to unblock Gemini.

### Process Invocation

```typescript
const proc = spawn('gemini', [
    '/conductor:newTrack',
    '--yolo',
    '--output-format', 'stream-json',
    taskDescription // Provide full objective and acceptance criteria here.
], {
    stdio: ['pipe', 'pipe', 'pipe'], // Critical
    cwd: workspacePath
});
```

### Event Handling
- stdout: Parse lines as JSON. Handle `message`, `thought`, `plan`, `tool_use`, `tool_result`, `error`, `done`, `result`.
- stderr: Monitor for Dev Server port declarations (e.g. Next.js `localhost:3000`) and emit `SERVICE_DEPLOYED`.
- stdin: Keep open to fulfill `ask_user` tool requests. Write responses ending with `\n`. Output closes naturally once a `result` or `done` JSON event indicates termination.
