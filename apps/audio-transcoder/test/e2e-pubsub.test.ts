/**
 * Full E2E Test with Pub/Sub Emulator
 *
 * This test runs the REAL audio-transcoder server from app.ts:
 * 1. Start Pub/Sub emulator
 * 2. Start the REAL audio-transcoder Fastify server (from createApp)
 * 3. Upload test audio to REAL R2 bucket
 * 4. Create topic and push subscription pointing to our server
 * 5. Publish a transcode message to Pub/Sub
 * 6. Pub/Sub emulator delivers the message to our /pubsub/push endpoint
 * 7. Real server downloads from R2, transcodes with real FFmpeg, uploads HLS to R2
 * 8. Verify HLS output exists in R2
 *
 * Prerequisites:
 * - gcloud CLI with pubsub-emulator component installed
 * - Java runtime (for the emulator)
 * - FFmpeg installed locally
 * - Docker running (for Postgres)
 * - .env.local configured with R2 credentials
 * - Test fixture: test/fixtures/test-audio.mp3
 *
 * Run with:
 *   export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"
 *   pnpm exec vitest --run test/e2e-pubsub.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PubSub, Topic, Subscription } from "@google-cloud/pubsub";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import type { FastifyInstance } from "fastify";
import type { FileStoragePort } from "@th/ports/file-storage";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load environment BEFORE anything else imports env.ts
// This mirrors what index.ts does
const appRoot = join(__dirname, "..");
dotenv.config({ path: join(appRoot, ".env.local"), override: true });
dotenv.config({
  path: join(appRoot, "../../.env.local"),
  override: !process.env.DATABASE_URL,
});

// Test configuration
const PUBSUB_EMULATOR_HOST = "localhost:8085";
const PUBSUB_PROJECT_ID = "test-project";
const TOPIC_NAME = "audio-transcode-requests";
const SUBSCRIPTION_NAME = "audio-transcode-push";
const SERVER_PORT = 3099;

const FIXTURES_DIR = join(__dirname, "fixtures");
const TEST_AUDIO_PATH = join(FIXTURES_DIR, "test-audio.mp3");

// R2 test prefix — all test objects are scoped here for easy cleanup
const R2_TEST_PREFIX = `__e2e-test__/audio-transcoder`;

// Helper to wait for emulator
async function waitForEmulator(
  host: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://${host}`);
      if (response.status === 404 || response.ok) return true;
    } catch {
      // Not ready yet
    }
    await sleep(300);
  }
  return false;
}

// Helper to poll R2 for HLS output
async function waitForR2Object(
  storage: FileStoragePort,
  key: string,
  timeoutMs = 90000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const head = await storage.headObject({ key });
      if (head.exists) return true;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  return false;
}

describe("E2E: Pub/Sub Integration (Real Server)", () => {
  let emulatorProcess: ChildProcess | null = null;
  let app: FastifyInstance | null = null;
  let r2: FileStoragePort | null = null;
  let pubsub: PubSub;
  let topic: Topic;
  let subscription: Subscription;
  let ffmpegAvailable = false;

  // Track R2 keys uploaded during tests for cleanup
  const r2KeysToCleanup: string[] = [];

  beforeAll(async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // Pre-flight checks
    // ─────────────────────────────────────────────────────────────────────────
    try {
      execSync("which ffmpeg", { stdio: "pipe" });
      ffmpegAvailable = true;
    } catch {
      console.warn("⚠️ FFmpeg not available, skipping Pub/Sub E2E tests");
      return;
    }

    if (!existsSync(TEST_AUDIO_PATH)) {
      throw new Error(`Test fixture not found: ${TEST_AUDIO_PATH}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Start Pub/Sub emulator
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🚀 Starting Pub/Sub emulator...");

    emulatorProcess = spawn(
      "gcloud",
      [
        "beta",
        "emulators",
        "pubsub",
        "start",
        `--host-port=${PUBSUB_EMULATOR_HOST}`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    emulatorProcess.stdout?.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Server started")) {
        console.log("   ✅ Pub/Sub emulator started");
      }
    });

    const emulatorReady = await waitForEmulator(PUBSUB_EMULATOR_HOST);
    if (!emulatorReady) {
      throw new Error("Pub/Sub emulator failed to start");
    }
    console.log("   ✅ Pub/Sub emulator ready");

    // Set environment for Pub/Sub client
    process.env.PUBSUB_EMULATOR_HOST = PUBSUB_EMULATOR_HOST;

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Start the REAL audio-transcoder server
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n🖥️  Starting REAL audio-transcoder server...");

    // Override PORT for test
    process.env.PORT = String(SERVER_PORT);

    // Import and create the REAL app (this also builds the container with R2)
    const { createApp } = await import("../src/app");
    const { app: fastifyApp, container } = await createApp();
    app = fastifyApp;
    r2 = container.fileStorage;

    await app.listen({ port: SERVER_PORT, host: "0.0.0.0" });
    console.log(`   ✅ Real server listening on port ${SERVER_PORT}`);

    // Verify health
    const healthCheck = await fetch(`http://localhost:${SERVER_PORT}/health`);
    const health = (await healthCheck.json()) as {
      status: string;
      ffmpeg: boolean;
    };
    console.log(`   Health: ${health.status}, FFmpeg: ${health.ffmpeg}`);

    if (!health.ffmpeg) {
      throw new Error("FFmpeg not available in server container");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Create Pub/Sub topic and push subscription
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n📬 Creating topic and subscription...");

    pubsub = new PubSub({ projectId: PUBSUB_PROJECT_ID });

    [topic] = await pubsub.createTopic(TOPIC_NAME);
    console.log(`   Topic: ${topic.name}`);

    // Push subscription pointing to our REAL server
    const pushEndpoint = `http://localhost:${SERVER_PORT}/pubsub/push`;
    [subscription] = await topic.createSubscription(SUBSCRIPTION_NAME, {
      pushConfig: { pushEndpoint },
      ackDeadlineSeconds: 120,
    });
    console.log(`   Subscription: ${subscription.name}`);
    console.log(`   Push endpoint: ${pushEndpoint}`);
  }, 60000);

  afterAll(async () => {
    console.log("\n🧹 Cleaning up...");

    // Clean up R2 test objects
    if (r2 && r2KeysToCleanup.length > 0) {
      console.log(
        `   🗑️  Cleaning up ${r2KeysToCleanup.length} R2 test objects...`,
      );
      for (const key of r2KeysToCleanup) {
        try {
          await r2.deleteObject({ key });
        } catch {
          // Best effort cleanup
        }
      }
      console.log("   ✅ R2 cleanup done");
    }

    // Stop real server
    if (app) {
      await app.close();
      console.log("   ✅ Real server stopped");
    }

    // Stop emulator
    if (emulatorProcess?.pid) {
      try {
        process.kill(-emulatorProcess.pid, "SIGTERM");
      } catch {
        emulatorProcess.kill("SIGTERM");
      }
      await sleep(500);
      console.log("   ✅ Emulator stopped");
    }

    delete process.env.PUBSUB_EMULATOR_HOST;
  });

  it("should receive Pub/Sub push and transcode audio via REAL server", async () => {
    if (!ffmpegAvailable) {
      console.warn("⚠️ Skipping: FFmpeg not available");
      return;
    }

    expect(r2).not.toBeNull();
    const storage = r2!;

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Upload test audio to R2
    // ─────────────────────────────────────────────────────────────────────────
    const jobId = randomUUID();
    const audioUploadId = randomUUID();
    const eventId = randomUUID();

    const sourceKey = `${R2_TEST_PREFIX}/${jobId}/source.mp3`;
    const outputPrefix = `${R2_TEST_PREFIX}/${jobId}/hls`;
    const playlistKey = `${outputPrefix}/audio.m3u8`;

    console.log("\n📝 Test setup:");
    console.log(`   Job ID: ${jobId}`);
    console.log(`   Audio Upload ID: ${audioUploadId}`);
    console.log(`   R2 Source Key: ${sourceKey}`);
    console.log(`   R2 Output Prefix: ${outputPrefix}`);

    // Read local test audio and upload to R2
    const audioBuffer = await readFile(TEST_AUDIO_PATH);
    console.log(
      `\n📤 Uploading test audio to R2 (${(audioBuffer.length / 1024).toFixed(1)} KB)...`,
    );

    const uploadResult = await storage.putObject({
      key: sourceKey,
      content: audioBuffer,
      options: { contentType: "audio/mpeg" },
    });
    r2KeysToCleanup.push(sourceKey);
    console.log(
      `   ✅ Uploaded to R2: ${sourceKey} (etag: ${uploadResult.etag})`,
    );

    // Verify it's there
    const head = await storage.headObject({ key: sourceKey });
    expect(head.exists).toBe(true);
    console.log(`   ✅ Verified in R2: size=${head.size} bytes`);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Publish message to Pub/Sub topic
    // The emulator will push to our REAL server's /pubsub/push endpoint
    // ─────────────────────────────────────────────────────────────────────────
    const messagePayload = {
      audioUploadId,
      eventId,
      sourceKey,
      outputPrefix,
      deleteSourceOnSuccess: false,
    };

    console.log("\n📤 Publishing message to Pub/Sub...");
    console.log(`   Payload: ${JSON.stringify(messagePayload, null, 2)}`);

    const messageId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(messagePayload)),
      attributes: { jobId },
    });
    console.log(`   ✅ Message published with ID: ${messageId}`);
    console.log(
      "\n⏳ Waiting for Pub/Sub emulator to deliver → REAL server → R2 HLS output...",
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Poll R2 for the HLS playlist to appear
    // ─────────────────────────────────────────────────────────────────────────
    const outputAppeared = await waitForR2Object(storage, playlistKey, 120000);

    if (!outputAppeared) {
      console.log("\n❌ HLS playlist did not appear in R2!");
      throw new Error(
        "Transcoding did not complete — HLS playlist not found in R2",
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Verify the R2 output
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n✅ HLS output detected in R2!");

    // List all objects under the output prefix
    const listing = await storage.listObjects({
      prefix: outputPrefix,
      limit: 100,
    });
    const allKeys = listing.keys.map((o) => o.key);
    console.log(`   Found ${allKeys.length} objects under ${outputPrefix}`);

    // Track for cleanup
    r2KeysToCleanup.push(...allKeys);

    // Verify playlist
    const playlistHead = await storage.headObject({ key: playlistKey });
    expect(playlistHead.exists).toBe(true);
    expect(playlistHead.contentType).toContain("mpegurl");

    // Verify segments exist
    const segmentKeys = allKeys.filter((k) => k.endsWith(".ts"));
    expect(segmentKeys.length).toBeGreaterThan(0);

    console.log("\n📊 Full E2E Flow Summary:");
    console.log("   1. Uploaded test audio to R2");
    console.log("   2. Published transcode message to Pub/Sub topic");
    console.log(
      `   3. Emulator pushed message to http://localhost:${SERVER_PORT}/pubsub/push`,
    );
    console.log("   4. REAL server downloaded source from R2");
    console.log("   5. FFmpeg transcoded MP3 → HLS");
    console.log(
      `   6. Server uploaded ${segmentKeys.length} HLS segments + playlist to R2`,
    );
    console.log(`   Playlist: ${playlistKey}`);
    console.log(`   Segments: ${segmentKeys.length}`);
    console.log(
      "\n✅ Full Pub/Sub → REAL Server → R2 → Transcode → R2 E2E flow completed!",
    );
  }, 180000);

  it("should handle pull subscription acknowledgment flow", async () => {
    if (!ffmpegAvailable) {
      console.warn("⚠️ Skipping: FFmpeg not available");
      return;
    }

    console.log("\n📬 Testing message acknowledgment flow...");

    const pullSubName = "audio-transcode-pull-test";
    const [pullSub] = await topic.createSubscription(pullSubName, {
      ackDeadlineSeconds: 10,
    });

    const testPayload = { test: "ack-flow", timestamp: Date.now() };
    const msgId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(testPayload)),
    });
    console.log(`   Published test message: ${msgId}`);

    const messagePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timeout waiting for message")),
        10000,
      );

      pullSub.on(
        "message",
        (message: { ack: () => void; id: string; data: Buffer }) => {
          clearTimeout(timeout);
          console.log(`   Received message: ${message.id}`);

          const receivedPayload = JSON.parse(message.data?.toString() || "{}");
          expect(receivedPayload.test).toBe("ack-flow");

          message.ack();
          console.log(`   ✅ Message acknowledged`);
          resolve();
        },
      );

      pullSub.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await messagePromise;

    pullSub.removeAllListeners();
    await pullSub.close();
    await pullSub.delete();
    console.log(`   ✅ Test subscription cleaned up`);
  }, 30000);
});
