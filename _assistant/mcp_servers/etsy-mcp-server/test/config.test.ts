import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadEtsyConfig } from '../src/config.js';

// tests must never touch a real etsy_mcp_settings.json in the project root,
// so point the loader at a temp file via ETSY_SETTINGS_PATH
let tmpDir: string;
let settingsPath: string;

const originalEnv = { ...process.env };

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etsy-mcp-config-test-'));
  settingsPath = path.join(tmpDir, 'etsy_mcp_settings.json');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (fs.existsSync(settingsPath)) {
    fs.unlinkSync(settingsPath);
  }
});

describe('loadEtsyConfig', () => {
  it('uses environment variables when set', () => {
    process.env.ETSY_SETTINGS_PATH = settingsPath;
    process.env.ETSY_API_KEY = 'key';
    process.env.ETSY_SHARED_SECRET = 'secret';
    process.env.ETSY_REFRESH_TOKEN = 'token';
    const cfg = loadEtsyConfig();
    expect(cfg).toEqual({ apiKey: 'key', sharedSecret: 'secret', refreshToken: 'token' });
  });

  it('reads from config file when env vars missing', () => {
    const data = {
      'etsy-mcp-server': {
        keystring: 'k',
        sharedSecret: 's',
        refreshToken: 'r',
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(data));
    process.env.ETSY_SETTINGS_PATH = settingsPath;
    delete process.env.ETSY_API_KEY;
    delete process.env.ETSY_SHARED_SECRET;
    delete process.env.ETSY_REFRESH_TOKEN;
    const cfg = loadEtsyConfig();
    expect(cfg).toEqual({ apiKey: 'k', sharedSecret: 's', refreshToken: 'r' });
  });

  it('does not delete the settings file after reading it', () => {
    const data = {
      'etsy-mcp-server': {
        keystring: 'k',
        sharedSecret: 's',
        refreshToken: 'r',
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(data));
    process.env.ETSY_SETTINGS_PATH = settingsPath;
    delete process.env.ETSY_API_KEY;
    delete process.env.ETSY_SHARED_SECRET;
    delete process.env.ETSY_REFRESH_TOKEN;
    loadEtsyConfig();
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('throws if config missing', () => {
    process.env.ETSY_SETTINGS_PATH = settingsPath;
    delete process.env.ETSY_API_KEY;
    delete process.env.ETSY_SHARED_SECRET;
    delete process.env.ETSY_REFRESH_TOKEN;
    expect(() => loadEtsyConfig()).toThrow(
      'ETSY_API_KEY, ETSY_SHARED_SECRET, and ETSY_REFRESH_TOKEN environment variables are required'
    );
  });
});
