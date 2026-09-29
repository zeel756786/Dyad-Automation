import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

/**
 * Client-facing step report.
 *
 * Runs alongside the other reporters wired in playwright.config.ts (it doesn't
 * replace the Playwright HTML report, the JSON report, or the scenario-
 * traceability reporter — see framework/utils/reporting.ts). Where those are
 * built for engineers, this one is built for demoing/sharing with a client:
 * one plain, self-contained HTML file, no server needed to view it, with
 * every test step listed in the order it ran and its screenshot(s) directly
 * underneath it.
 *
 * It relies on the attachment naming convention produced by
 * framework/utils/reportStep.ts's `runStep()` helper:
 *
 *   "Step <n> | <step title> | <verification label>"
 *
 * Any spec that doesn't use `runStep()` still shows up in this report (title,
 * status, duration, errors) — it just won't have step/screenshot detail,
 * since there's nothing to group. Screenshots attached via
 * framework/utils/screenshot.ts's `takeScreenshot()` outside of a `runStep()`
 * step are listed under an "Other screenshots" bucket instead of being lost.
 */

const REPORTS_DIR = join(__dirname, '../../reports/client-report');

const ATTACHMENT_NAME_PATTERN = /^Step (\d+) \| (.*?) \| (.*)$/;

interface Shot {
  label: string;
  dataUri: string;
}

interface StepGroup {
  index: number;
  title: string;
  shots: Shot[];
}

interface TestRow {
  title: string;
  file: string;
  scenario: string;
  product: string | null;
  status: TestResult['status'];
  durationMs: number;
  steps: StepGroup[];
  otherShots: Shot[];
  errors: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scenarioIdFor(test: TestCase): string {
  const ann = test.annotations.find((a) => a.type === 'scenario');
  return ann?.description ?? 'unattributed';
}

function productFor(test: TestCase): string | null {
  const ann = test.annotations.find((a) => a.type === 'product');
  return ann?.description ?? null;
}

function statusMeta(status: TestResult['status']): { label: string; className: string } {
  switch (status) {
    case 'passed':
      return { label: 'PASSED', className: 'status-passed' };
    case 'failed':
    case 'timedOut':
    case 'interrupted':
      return { label: 'FAILED', className: 'status-failed' };
    case 'skipped':
      return { label: 'SKIPPED', className: 'status-skipped' };
    default:
      return { label: String(status).toUpperCase(), className: 'status-skipped' };
  }
}

export default class ClientStepReporter implements Reporter {
  private rows: TestRow[] = [];
  private startedAt = new Date();

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.rows = [];
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const steps: StepGroup[] = [];
    const otherShots: Shot[] = [];
    let current: StepGroup | null = null;

    for (const attachment of result.attachments) {
      if (!attachment.contentType.startsWith('image/')) continue;
      if (!attachment.body) continue; // large attachments written to disk only — skip rather than fail

      const dataUri = `data:${attachment.contentType};base64,${attachment.body.toString('base64')}`;
      const match = attachment.name.match(ATTACHMENT_NAME_PATTERN);

      if (!match) {
        otherShots.push({ label: attachment.name, dataUri });
        continue;
      }

      const index = Number(match[1]);
      const title = match[2];
      const label = match[3];

      if (!current || current.index !== index) {
        current = { index, title, shots: [] };
        steps.push(current);
      }
      current.shots.push({ label, dataUri });
    }

    this.rows.push({
      title: test.titlePath().slice(1).join(' > '),
      file: test.location.file,
      scenario: scenarioIdFor(test),
      product: productFor(test),
      status: result.status,
      durationMs: result.duration,
      steps,
      otherShots,
      errors: result.errors.map((e) => e.message ?? String(e)).filter(Boolean),
    });
  }

  onEnd(_result: FullResult): void {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(join(REPORTS_DIR, 'index.html'), this.buildHtml());
  }

  private buildHtml(): string {
    const total = this.rows.length;
    const passed = this.rows.filter((r) => r.status === 'passed').length;
    const failed = this.rows.filter((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted').length;
    const skipped = this.rows.filter((r) => r.status === 'skipped').length;

    const nav = this.rows
      .map(
        (row, i) =>
          `<a href="#test-${i}" class="nav-link ${statusMeta(row.status).className}">${escapeHtml(row.title)}</a>`,
      )
      .join('\n');

    const sections = this.rows.map((row, i) => this.buildTestSection(row, i)).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Test Run Report — ${this.startedAt.toLocaleString()}</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card-bg: #ffffff;
    --text: #1f2430;
    --muted: #6b7280;
    --border: #e3e6eb;
    --passed: #1a8754;
    --failed: #d64545;
    --skipped: #9a8b1f;
    --accent: #2563eb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
  }
  aside {
    width: 300px;
    flex-shrink: 0;
    height: 100vh;
    overflow-y: auto;
    background: var(--card-bg);
    border-right: 1px solid var(--border);
    padding: 20px 0;
    position: sticky;
    top: 0;
  }
  aside h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); padding: 0 20px; margin: 0 0 10px; }
  .nav-link {
    display: block;
    padding: 8px 20px;
    font-size: 13px;
    text-decoration: none;
    color: var(--text);
    border-left: 3px solid transparent;
    line-height: 1.4;
  }
  .nav-link:hover { background: #f0f2f5; }
  .nav-link.status-passed { border-left-color: var(--passed); }
  .nav-link.status-failed { border-left-color: var(--failed); }
  .nav-link.status-skipped { border-left-color: var(--skipped); }
  main { flex: 1; padding: 32px 40px; max-width: 1100px; }
  header.summary {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 28px;
  }
  header.summary h1 { margin: 0 0 6px; font-size: 22px; }
  header.summary .timestamp { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .pill-row { display: flex; gap: 10px; flex-wrap: wrap; }
  .pill { border-radius: 999px; padding: 4px 14px; font-size: 13px; font-weight: 600; }
  .pill.total { background: #eef1f5; color: var(--text); }
  .pill.passed { background: #e5f6ec; color: var(--passed); }
  .pill.failed { background: #fbe9e9; color: var(--failed); }
  .pill.skipped { background: #f8f2df; color: var(--skipped); }
  .test-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 32px;
    overflow: hidden;
    scroll-margin-top: 20px;
  }
  .test-card-header { padding: 18px 24px; border-bottom: 1px solid var(--border); }
  .test-card-header .title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .test-card-header h2 { margin: 0; font-size: 17px; }
  .badge { border-radius: 6px; padding: 3px 10px; font-size: 12px; font-weight: 700; letter-spacing: .03em; }
  .badge.status-passed { background: var(--passed); color: #fff; }
  .badge.status-failed { background: var(--failed); color: #fff; }
  .badge.status-skipped { background: var(--skipped); color: #fff; }
  .meta-row { margin-top: 6px; color: var(--muted); font-size: 12.5px; }
  .meta-row span { margin-right: 16px; }
  .errors { background: #fbe9e9; color: #7a1f1f; padding: 12px 24px; font-size: 13px; white-space: pre-wrap; border-bottom: 1px solid var(--border); }
  .steps { padding: 8px 24px 20px; }
  .step { padding: 16px 0; border-bottom: 1px dashed var(--border); }
  .step:last-child { border-bottom: none; }
  .step h3 { margin: 0 0 12px; font-size: 15px; }
  .step h3 .step-number { color: var(--accent); margin-right: 6px; }
  .shots { display: flex; flex-direction: column; gap: 18px; }
  .shot figure { margin: 0; }
  .shot figcaption { font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
  .shot img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; display: block; }
  .shot.failed figcaption { color: var(--failed); font-weight: 700; }
  .shot.failed img { border-color: var(--failed); }
  .no-shots { padding: 16px 24px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
  <aside>
    <h2>Tests</h2>
    ${nav}
  </aside>
  <main>
    <header class="summary">
      <h1>Test Run Report</h1>
      <div class="timestamp">Generated ${this.startedAt.toLocaleString()}</div>
      <div class="pill-row">
        <span class="pill total">${total} total</span>
        <span class="pill passed">${passed} passed</span>
        <span class="pill failed">${failed} failed</span>
        <span class="pill skipped">${skipped} skipped</span>
      </div>
    </header>
    ${sections}
  </main>
</body>
</html>`;
  }

  private buildTestSection(row: TestRow, index: number): string {
    const meta = statusMeta(row.status);
    const seconds = (row.durationMs / 1000).toFixed(1);

    const errorsHtml = row.errors.length
      ? `<div class="errors">${row.errors.map((e) => escapeHtml(e)).join('\n\n')}</div>`
      : '';

    const stepsHtml = row.steps
      .map((step) => {
        const shotsHtml = step.shots
          .map((shot) => {
            const failedClass = shot.label.toUpperCase() === 'FAILED' ? ' failed' : '';
            return `<div class="shot${failedClass}">
              <figure>
                <figcaption>${escapeHtml(shot.label)}</figcaption>
                <img src="${shot.dataUri}" alt="${escapeHtml(step.title)} — ${escapeHtml(shot.label)}" loading="lazy" />
              </figure>
            </div>`;
          })
          .join('\n');

        return `<div class="step">
          <h3><span class="step-number">Step ${step.index}.</span>${escapeHtml(step.title)}</h3>
          <div class="shots">${shotsHtml}</div>
        </div>`;
      })
      .join('\n');

    const otherShotsHtml = row.otherShots.length
      ? `<div class="step">
          <h3>Other screenshots</h3>
          <div class="shots">${row.otherShots
            .map(
              (shot) => `<div class="shot">
                <figure>
                  <figcaption>${escapeHtml(shot.label)}</figcaption>
                  <img src="${shot.dataUri}" alt="${escapeHtml(shot.label)}" loading="lazy" />
                </figure>
              </div>`,
            )
            .join('\n')}</div>
        </div>`
      : '';

    const body =
      stepsHtml || otherShotsHtml
        ? `<div class="steps">${stepsHtml}${otherShotsHtml}</div>`
        : `<div class="no-shots">No step screenshots recorded for this test.</div>`;

    return `<section class="test-card" id="test-${index}">
      <div class="test-card-header">
        <div class="title-row">
          <span class="badge ${meta.className}">${meta.label}</span>
          <h2>${escapeHtml(row.title)}</h2>
        </div>
        <div class="meta-row">
          <span>Scenario: ${escapeHtml(row.scenario)}</span>
          <span>Product: ${escapeHtml(row.product ?? 'n/a')}</span>
          <span>Duration: ${seconds}s</span>
          <span>File: ${escapeHtml(row.file)}</span>
        </div>
      </div>
      ${errorsHtml}
      ${body}
    </section>`;
  }
}