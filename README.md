# ai-hivemind

**Agentic Control Plane & Execution Environment**

A real-time, WebSocket-driven command center providing absolute observability into AI agent swarms — enabling monitoring, interception, and steering of polymorphic swarms of built-in and runtime-generated agents.

---

## Documentation

| Document | Description |
|---|---|
| [VISION.md](docs/VISION.md) | Problem statement, solution manifesto, non-negotiable principles |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, agent hierarchy, A2A protocol, ledger schema |
| [WORKFLOW.md](docs/WORKFLOW.md) | Turborepo CI/CD, packages/shared governance, PR rules |

---

## Monorepo Structure

```
ai-hivemind/
├── apps/
│   ├── web/          # Command Center UI (React 19 + D3 + Zustand)
│   ├── backend/      # Nerve Center (Fastify + WebSocket + PostgreSQL)
│   └── sandbox/      # Agent Execution Environment orchestration
├── packages/
│   ├── shared/       # TypeScript types, Zod schemas, data contracts (THE CONTRACT LAYER)
│   └── ui/           # Shared React component library
└── docs/             # Architecture documentation
```

## Prerequisites

- **Node.js** ≥ 20.0.0
- **pnpm** ≥ 9.0.0 (`npm install -g pnpm`)
- **Docker** (for running sandbox environments locally)

## Getting Started

```bash
# Install dependencies
pnpm install

# Build all packages (respects dependency graph)
pnpm build

# Start all development servers
pnpm dev

# Run all tests
pnpm test

# Lint the entire workspace
pnpm lint

# Type-check the entire workspace
pnpm type-check
```

## Key Rules

1. **Never import from sub-paths of `@ai-hivemind/shared`** — always use the root import.
2. **Never use `npm` or `yarn`** — this repo uses `pnpm` exclusively.
3. **Never bypass CI** — all PRs must pass the full pipeline before merge.
4. **All cross-boundary types live in `packages/shared`** — never redeclare them in `apps/*`.

See [WORKFLOW.md](docs/WORKFLOW.md) for the complete rules of engagement.

---

*Built with the principle that AI agent swarms must be observable, steerable, and auditable from day one.*
