import { test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Step + screenshot reporting helper.
 *
 * Wraps Playwright's built-in `test.step()` so that every step in a spec:
 *   1. Is logged to the console as it starts and finishes (or fails).
 *   2. Gets a full-page screenshot attached right after each verification
 *      inside it (via `ctx.verify(...)`), or one screenshot at the end of the
 *      step if it does no explicit verification.
 *   3. Pauses for a configurable delay after the step completes, so a headed
 *      run is watchable at demo speed for a client instead of flashing by.
 *
 * The attachment `name` is intentionally formatted as
 *   "Step <n> | <step title> | <verification label>"
 * so the ClientStepReporter (framework/reporters/client-step-reporter.ts) can
 * group screenshots under the right step, in order, when it builds the
 * step-by-step HTML report. Don't change this format without updating that
 * reporter's parser to match.
 *
 * Usage in a spec:
 *
 *   import { runStep } from '../../../framework/utils/reportStep';
 *
 *   await runStep(page, testInfo, 'Confirm the dashboard loaded', async (ctx) => {
 *     await ctx.verify('URL moved to a hash route', () => expect(page).toHaveURL(/#\//));
 *     await ctx.verify('Greeting is visible', () =>
 *       expect(page.getByText(/Good (Morning|Afternoon|Evening),/)).toBeVisible(),
 *     );
 *   });
 *
 * A step with no `ctx.verify(...)` calls still gets one "Step complete"
 * screenshot automatically, so plain action-only steps are covered too:
 *
 *   await runStep(page, testInfo, 'Fill in Client Contacts (step 2)', async () => {
 *     await createClientPage.fillContactLastName(client.contactLastName);
 *     await createClientPage.clickSaveContact();
 *     await createClientPage.clickNext();
 *   });
 */

/** Set DEMO_MODE=false to skip the pause entirely (e.g. in CI, for speed). */
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

/** Override with DEMO_STEP_DELAY_MS (milliseconds). Defaults to 2 seconds. */
const DEMO_DELAY_MS = Number.isFinite(Number(process.env.DEMO_STEP_DELAY_MS))
  ? Number(process.env.DEMO_STEP_DELAY_MS)
  : 2000;

export interface StepContext {
  /**
   * Runs `assertion()` and, once it passes, attaches a screenshot labeled
   * with `label`. Call it once per verification/expect inside a step — each
   * call gets its own screenshot in the report, in order.
   */
  verify: (label: string, assertion: () => Promise<void> | void) => Promise<void>;
}

let stepCounters = new WeakMap<TestInfo, number>();

function nextStepIndex(testInfo: TestInfo): number {
  const current = stepCounters.get(testInfo) ?? 0;
  const next = current + 1;
  stepCounters.set(testInfo, next);
  return next;
}

/** Keeps attachment names on a single line and free of the `|` delimiter
 * the reporter splits on. */
function sanitizeForAttachmentName(value: string): string {
  return value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

export async function runStep<T = void>(
  page: Page,
  testInfo: TestInfo,
  title: string,
  action: (ctx: StepContext) => Promise<T>,
): Promise<T> {
  return test.step(title, async () => {
    const stepIndex = nextStepIndex(testInfo);
    const safeTitle = sanitizeForAttachmentName(title);
    let verifyCount = 0;

    console.log(`\n▶ Step ${stepIndex}: ${title}`);

    const capture = async (label: string): Promise<void> => {
      const body = await page.screenshot({ fullPage: true });
      const name = `Step ${stepIndex} | ${safeTitle} | ${sanitizeForAttachmentName(label)}`;
      await testInfo.attach(name, { body, contentType: 'image/png' });
    };

    const ctx: StepContext = {
      verify: async (label, assertion) => {
        await assertion();
        verifyCount += 1;
        await capture(label);
        console.log(`   ✓ Verified: ${label}`);
      },
    };

    try {
      const result = await action(ctx);

      if (verifyCount === 0) {
        await capture('Step complete');
      }

      if (DEMO_MODE && DEMO_DELAY_MS > 0) {
        await page.waitForTimeout(DEMO_DELAY_MS);
      }

      console.log(`✔ Step ${stepIndex} finished: ${title}`);
      return result;
    } catch (error) {
      // Capture what the screen looked like at the moment of failure too —
      // don't let a screenshot failure mask the original error.
      await capture('FAILED').catch(() => {});
      console.log(`✘ Step ${stepIndex} failed: ${title}`);
      throw error;
    }
  });
}