import { config as dotenvConfig } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.APPIUM_HOME =
  process.env.APPIUM_HOME ?? path.join(os.homedir(), ".appium");

dotenvConfig({ path: process.env.E2E_ENV_PATH ?? "../../.env.local" });

const APP_NAME = process.env.E2E_APP_NAME ?? "IthasFireScanner";
const APP_BUNDLE_ID = process.env.E2E_APP_BUNDLE_ID ?? "com.anonymous.scanner";

function findAppPath() {
  const releasePath = path.resolve(
    __dirname,
    `../ios/build/Build/Products/Release-iphonesimulator/${APP_NAME}.app`,
  );
  if (fs.existsSync(releasePath)) return releasePath;

  const debugPath = path.resolve(
    __dirname,
    `../ios/build/Build/Products/Debug-iphonesimulator/${APP_NAME}.app`,
  );
  if (fs.existsSync(debugPath)) return debugPath;

  try {
    const derived = execSync(
      `find ~/Library/Developer/Xcode/DerivedData -name "${APP_NAME}.app" -path "*/Debug-iphonesimulator/*" -type d 2>/dev/null | head -1`,
      { encoding: "utf8" },
    ).trim();
    if (derived && fs.existsSync(derived)) return derived;
  } catch {}

  return releasePath;
}

const appPath = process.env.E2E_APP_PATH ?? findAppPath();
const appBundleId = APP_BUNDLE_ID;
const appiumPort = Number(process.env.APPIUM_PORT ?? 4723);
const metroStatusUrl =
  process.env.E2E_METRO_STATUS_URL ?? "http://localhost:8082/status";
const metroTimeoutMs = Number(process.env.E2E_METRO_TIMEOUT_MS ?? 2000);

const checkMetroStatus = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), metroTimeoutMs);

  try {
    const response = await fetch(metroStatusUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Metro responded with status ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Metro dev server is not reachable at ${metroStatusUrl}. ` +
        `Start it with: pnpm -F scanner exec expo start --port 8082\n` +
        `Details: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
};

const deviceName = process.env.E2E_DEVICE_NAME ?? "iPhone 16";
const platformVersion = process.env.E2E_PLATFORM_VERSION ?? "18.6";
const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3001";

const ensureScannerAppForegrounded = async () => {
  const state = await browser.queryAppState(appBundleId);

  if (state !== 4) {
    await browser.activateApp(appBundleId);
  }

  await browser.waitUntil(
    async () => (await browser.queryAppState(appBundleId)) === 4,
    {
      timeout: 10_000,
      timeoutMsg: `Scanner app ${appBundleId} did not reach the foreground.`,
    },
  );
};

export const config = {
  runner: "local",
  port: appiumPort,
  specs: ["./tests/**/*.spec.js"],
  maxInstances: 1,
  logLevel: "info",
  bail: 0,
  baseUrl: apiBaseUrl,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  services: [
    [
      "appium",
      {
        command: "appium",
        args: { port: appiumPort },
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 300_000,
  },
  onPrepare: async () => {
    await checkMetroStatus();
  },
  before: async () => {
    await ensureScannerAppForegrounded();
  },
  beforeTest: async () => {
    await ensureScannerAppForegrounded();
  },
  capabilities: [
    {
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:deviceName": deviceName,
      "appium:platformVersion": platformVersion,
      "appium:app": appPath,
      "appium:bundleId": appBundleId,
      "appium:newCommandTimeout": 300,
      "appium:autoAcceptAlerts": true,
      "appium:connectHardwareKeyboard": true,
    },
  ],
};
