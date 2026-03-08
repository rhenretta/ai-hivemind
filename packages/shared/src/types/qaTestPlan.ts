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
});
export type QaTestItem = z.infer<typeof QaTestItemSchema>;

// ─── Full test plan ─────────────────────────────────────────────────────────

export const QaTestPlanSchema = z.object({
    /** Ordered list of tests */
    tests: z.array(QaTestItemSchema),
});
export type QaTestPlan = z.infer<typeof QaTestPlanSchema>;
