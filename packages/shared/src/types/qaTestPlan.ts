/**
 * qaTestPlan.ts — QA Test Plan types (Zod-first)
 *
 * Structured test plan that the QA Engineer agent creates, executes,
 * and revises during validation. Emitted on STATE_CHANGED and QA_VERDICT
 * events for frontend visibility.
 */

import { z } from 'zod';

// ─── Test type: what kind of check this test performs ────────────────────────

export const QaTestTypeSchema = z.enum([
    'api',          // HTTP endpoint probing (health, status, response body)
    'visual',       // Screenshot + vision analysis
    'build',        // Compile / lint / test suite checks
    'content',      // Response body validation (schema, data, structure)
    'interaction',  // Browser interaction tests (click, fill, navigate, form submit)
    'custom',       // Agent-defined test type
]);
export type QaTestType = z.infer<typeof QaTestTypeSchema>;

// ─── Test status: current execution state ───────────────────────────────────

export const QaTestStatusSchema = z.enum([
    'pending',  // Not yet executed
    'running',  // Currently being executed
    'passed',   // Test passed
    'failed',   // Test failed
    'skipped',  // Deliberately skipped
]);
export type QaTestStatus = z.infer<typeof QaTestStatusSchema>;

// ─── Test severity: does a failure block the verdict? ────────────────────────

export const QaTestSeveritySchema = z.enum([
    'blocking',  // Failure means the task is not done — verdict FAILS
    'warning',   // Imperfect but functional — verdict PASSES with warnings
]);
export type QaTestSeverity = z.infer<typeof QaTestSeveritySchema>;

// ─── Individual test item ───────────────────────────────────────────────────

export const QaTestItemSchema = z.object({
    /** Unique test identifier, e.g. "api-health-check", "visual-homepage" */
    id: z.string().min(1),
    /** Human-readable test name */
    name: z.string().min(1),
    /** What this test verifies */
    description: z.string(),
    /** Test category */
    type: QaTestTypeSchema,
    /** Current execution status */
    status: QaTestStatusSchema,
    /** Pass/fail explanation — set when status is passed, failed, or skipped */
    result: z.string().optional(),
    /**
     * Whether a failure blocks the verdict. Defaults to 'blocking' if omitted.
     *   'blocking' → core functionality is broken, verdict must FAIL
     *   'warning'  → edge case or imperfect behavior, verdict can PASS with noted warnings
     */
    severity: QaTestSeveritySchema.default('blocking'),
});
export type QaTestItem = z.infer<typeof QaTestItemSchema>;

// ─── Full test plan ─────────────────────────────────────────────────────────

export const QaTestPlanSchema = z.object({
    /** Ordered list of tests */
    tests: z.array(QaTestItemSchema),
});
export type QaTestPlan = z.infer<typeof QaTestPlanSchema>;

// ─── QA Arbiter Decision ────────────────────────────────────────────────────

/**
 * Decision returned by the QA arbiter after examining the full attempt history.
 * The arbiter replaces the hardcoded retry limit with intelligent routing:
 *   retry    → SWE gets another attempt with refined feedback
 *   ask_user → escalate to user for clarification; node enters 'blocked' status
 *   accept   → override QA failure — implementation satisfies actual criteria
 */
export const QaArbiterDecisionSchema = z.object({
    /** What to do next */
    decision: z.enum(['retry', 'ask_user', 'accept']),
    /** Why this decision was made */
    reasoning: z.string(),
    /** Refined, actionable instructions for SWE (retry only) */
    sweFeedback: z.string().optional(),
    /** Guidance for QA to avoid past mistakes on next run (retry only) */
    qaGuidance: z.string().optional(),
    /** Refined acceptance criteria if the originals were ambiguous or QA was inventing requirements */
    updatedAcceptanceCriteria: z.string().optional(),
    /** Specific question for the user (ask_user only) */
    userQuestion: z.string().optional(),
});
export type QaArbiterDecision = z.infer<typeof QaArbiterDecisionSchema>;
