import { expect, test } from "./fixtures";
import { resetE2eState } from "./helpers/e2e-reset";
import path from "path";
import fs from "fs";
import os from "os";

// ─────────────────────────────────────────────────────────────────────────────
// ProseEditor Audio Upload E2E
// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline test: upload → transcode → playable URL.
//
// Preconditions:
//   - API running with AUDIO_TRANSCODER_URL set
//   - Audio transcoder service running
//   - S3/MinIO running with CORS enabled
//   - Playwright "setup" project has stored a signed-in session
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL =
  process.env.E2E_API_BASE_URL ??
  process.env.PLAYWRIGHT_API_BASE_URL ??
  "http://localhost:3001";

const E2E_SECRET = process.env.E2E_RESET_SECRET ?? "playwright-reset-secret";

const TEST_EMAIL =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  process.env.PLAYWRIGHT_TEST_IDENTIFIER ??
  "playwright-setup@example.com";

const TRANSCODE_TIMEOUT_MS = 120_000;

interface EventBuilderSeed {
  humanId: string;
  orgId: string;
  orgSlug: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  ticketTypeId: string;
}

/** Create a minimal valid WAV file — 0.5s of silence at 8kHz mono. */
function createTestWav(): string {
  const numChannels = 1;
  const sampleRate = 8000;
  const bitsPerSample = 16;
  const numSamples = 4000;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buf = Buffer.alloc(fileSize);
  let offset = 0;

  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(fileSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;
  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt16LE(numChannels, offset);
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), offset);
  offset += 4;
  buf.writeUInt16LE(numChannels * (bitsPerSample / 8), offset);
  offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset);
  offset += 2;
  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(dataSize, offset);
  offset += 4;

  const tmpPath = path.join(os.tmpdir(), `e2e-test-audio-${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/**
 * Wait for the EventBuilder to finish loading event data into the form.
 * The ProseEditor remounts when data loads (key changes from "fresh" to "loaded"),
 * so we must wait for this before triggering uploads.
 */
async function waitForEventDataLoaded(page: import("@playwright/test").Page) {
  // Wait for the prose editor itself to mount — that's our stable signal
  // that the EventBuilder finished loading event data and remounted with
  // `key="loaded"`. The earlier `getByText("Edit Event")` selector relied
  // on header chrome that has since changed.
  await expect(page.locator('[data-testid="prose-editor"]')).toBeVisible({
    timeout: 15_000,
  });
  // The title input is pre-populated once the event data loads
  const titleInput = page.locator('input[placeholder*="event called"]');
  await expect(titleInput).toHaveValue(/\S/, { timeout: 15_000 });
}

test.describe("ProseEditor Audio Upload", () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name === "guest",
      "guest project is unauthenticated",
    );
  });

  let seed: EventBuilderSeed;
  let testAudioPath: string;

  test.beforeAll(async ({ request }) => {
    await resetE2eState(request, API_BASE_URL, {
      preserveEmail: TEST_EMAIL,
    });

    await request.post(`${API_BASE_URL}/e2e/auth/verify-email`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: { email: TEST_EMAIL },
    });

    const res = await request.post(`${API_BASE_URL}/e2e/seed/event-builder`, {
      headers: {
        "x-e2e-reset-secret": E2E_SECRET,
        "content-type": "application/json",
      },
      data: {
        email: TEST_EMAIL,
        stripeAccountId: `acct_e2e_audio_${Date.now()}`,
      },
    });

    expect(res.ok(), `Seed failed: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    seed = body.seed;
    expect(seed.orgSlug).toBeTruthy();
    expect(seed.eventId).toBeTruthy();

    testAudioPath = createTestWav();
  });

  test.afterAll(() => {
    if (testAudioPath && fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  // ═════════════════════════════════════════════════════════════════════

  test("audio upload button is visible in edit mode", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await waitForEventDataLoaded(page);

    const uploadBtn = page.getByTestId("prose-audio-upload-btn");
    await expect(uploadBtn).toBeVisible();
  });

  test("uploading audio inserts a block and transcodes to a playable URL", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();
    test.setTimeout(TRANSCODE_TIMEOUT_MS + 30_000);

    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await waitForEventDataLoaded(page);

    const fileInput = page.getByTestId("prose-audio-file-input");
    await expect(fileInput).toBeAttached({ timeout: 5_000 });

    await fileInput.setInputFiles(testAudioPath);

    // ── Phase 1: Block appears ──
    const audioBlock = page.getByTestId("audio-block");
    await expect(audioBlock).toBeVisible({ timeout: 30_000 });

    const titleText = path.basename(testAudioPath, ".wav");
    await expect(audioBlock.getByText(titleText)).toBeVisible({
      timeout: 10_000,
    });

    // ── Phase 2: Wait for transcoding ──
    const audioElement = audioBlock.locator("audio");
    await expect(audioElement).toBeAttached({ timeout: TRANSCODE_TIMEOUT_MS });

    // The player attaches its src in an effect (attachAudioSource): the
    // direct file or a native playlist is http(s); hls.js gives a blob: URL.
    await expect(
      audioElement,
      "audio element should have an http(s) or blob: src",
    ).toHaveAttribute("src", /^(https?|blob):/);

    const playBtn = page.getByTestId("audio-block-play");
    await expect(playBtn).toBeVisible({ timeout: 5_000 });
  });

  test("transcoded audio persists after saving and reloading", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();
    test.setTimeout(TRANSCODE_TIMEOUT_MS + 60_000);

    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await waitForEventDataLoaded(page);

    const fileInput = page.getByTestId("prose-audio-file-input");
    await fileInput.setInputFiles(testAudioPath);

    const audioBlock = page.getByTestId("audio-block");
    await expect(audioBlock).toBeVisible({ timeout: 30_000 });

    const audioElement = audioBlock.locator("audio");
    await expect(audioElement).toBeAttached({ timeout: TRANSCODE_TIMEOUT_MS });

    await expect(audioElement).toHaveAttribute("src", /^(https?|blob):/);

    // Save button may be "Save Draft" or "Save" depending on event status
    const saveBtn = page.getByRole("button", { name: /save/i });
    await expect(saveBtn.first()).toBeEnabled({ timeout: 5_000 });
    await saveBtn.first().click();
    await page.waitForTimeout(3_000);

    await page.reload();
    await waitForEventDataLoaded(page);

    const audioBlockAfterReload = page.getByTestId("audio-block");
    await expect(audioBlockAfterReload).toBeVisible({ timeout: 30_000 });

    const audioAfterReload = audioBlockAfterReload.locator("audio");
    await expect(audioAfterReload).toBeAttached({ timeout: 30_000 });

    await expect(
      audioAfterReload,
      "audio src should persist after reload",
    ).toHaveAttribute("src", /^(https?|blob):/);
  });

  test("audio block can be deleted in edit mode", async ({
    page,
    consoleErrors,
  }) => {
    consoleErrors.ignore();

    await page.goto(`/admin/${seed.orgSlug}/events/${seed.eventId}`);
    await waitForEventDataLoaded(page);

    const fileInput = page.getByTestId("prose-audio-file-input");
    await fileInput.setInputFiles(testAudioPath);

    const audioBlock = page.getByTestId("audio-block");
    await expect(audioBlock).toBeVisible({ timeout: 30_000 });

    await audioBlock.click();

    const deleteBtn = page.getByTestId("audio-block-delete");
    await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
    await deleteBtn.click();

    await expect(audioBlock).not.toBeVisible({ timeout: 5_000 });
  });
});
