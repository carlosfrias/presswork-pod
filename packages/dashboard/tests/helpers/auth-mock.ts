import { vi } from "vitest";

export const TEST_OWNER_EMAIL = "owner@test.com";

/**
 * Stub `@/lib/auth` so server actions pass `assertOwner()` in tests.
 * Call this at the top of any action test file BEFORE importing the action under test.
 *
 *     vi.mock("@/lib/auth", () => ({ requireOwnerEmail: vi.fn(async () => TEST_OWNER_EMAIL) }));
 *
 * This helper just centralises the email constant; the vi.mock call has to live
 * in the test file itself so it's hoisted before module evaluation.
 */
export const requireOwnerEmailMock = vi.fn(async () => TEST_OWNER_EMAIL);
