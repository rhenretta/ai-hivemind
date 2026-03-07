/**
 * @ai-hivemind/shared — Public API
 *
 * This is the ONLY import surface for consumers of this package.
 * Do not import from sub-paths (e.g., @ai-hivemind/shared/types/agent).
 * All exports must be re-exported from this file.
 *
 * See docs/WORKFLOW.md §2 for the versioning and governance rules.
 */

// ─── Agent Types ──────────────────────────────────────────────────────────────
export * from './types/agent.js';

// ─── Event Types ──────────────────────────────────────────────────────────────
export * from './types/events.js';

// ─── Messaging Protocol ───────────────────────────────────────────────────────
export * from './types/messages.js';

// ─── Telemetry ────────────────────────────────────────────────────────────────
export * from './types/telemetry.js';

// ─── Interrupt Protocol ───────────────────────────────────────────────────────
export * from './types/interrupts.js';

// ─── MCP Tool Registry ────────────────────────────────────────────────────────
export * from './types/tools.js';

// ─── Error Taxonomy ───────────────────────────────────────────────────────────
export * from './types/errors.js';

// ─── Agent Working Memory (RAG Store) ─────────────────────────────────────────
export * from './types/memory.js';

// ─── Task Graph (Orchestration Engine) ───────────────────────────────────────
export * from './types/taskGraph.js';

// ─── Credential Store ────────────────────────────────────────────────────────
export * from './types/credentials.js';

// ─── UX Design Spec ─────────────────────────────────────────────────────────
export * from './types/uxDesign.js';

// ─── QA Test Plan ───────────────────────────────────────────────────────────
export * from './types/qaTestPlan.js';
