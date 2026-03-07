/**
 * uxDesign.ts — UX Design Specification types
 *
 * The UxDesignSpec captures the UX Designer agent's output:
 * layout, component hierarchy, user flow, styling, wireframe,
 * and UX-specific acceptance criteria.
 *
 * This spec is consumed by:
 *   - TaskOrchestrator: feeds into decomposer + SWE objective
 *   - QaEngineer: visual validation benchmark
 */

import { z } from 'zod';

export const UxDesignSpecSchema = z.object({
    /** High-level page/feature layout description */
    layout: z.string(),

    /** Component hierarchy — what components to build and how they nest */
    componentHierarchy: z.string(),

    /** User interaction flow — step by step how the user uses the feature */
    userFlow: z.string(),

    /** Styling guidelines — colors, spacing, typography, responsive behavior */
    styling: z.string(),

    /** Text wireframe / ASCII mockup of the key screens */
    wireframe: z.string(),

    /** Refined acceptance criteria that include UX requirements */
    uxAcceptanceCriteria: z.string(),
});
export type UxDesignSpec = z.infer<typeof UxDesignSpecSchema>;
