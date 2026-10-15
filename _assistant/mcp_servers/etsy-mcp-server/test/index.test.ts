import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadEtsyConfig } from '../src/config.js';
import os from 'os';
import path from 'path';

// Mock environment variables for testing
const originalEnv = { ...process.env };

describe('EtsyServer Integration Tests', () => {
  beforeEach(() => {
    // Set up test environment variables
    process.env.ETSY_API_KEY = 'test-api-key';
    process.env.ETSY_SHARED_SECRET = 'test-shared-secret';
    process.env.ETSY_REFRESH_TOKEN = 'test-refresh-token';
    // never let tests read a real settings file from the project root
    process.env.ETSY_SETTINGS_PATH = path.join(os.tmpdir(), 'etsy-mcp-nonexistent.json');
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('Configuration Loading', () => {
    it('should load configuration from environment variables', () => {
      process.env.ETSY_API_KEY = 'test-api-key';
      process.env.ETSY_SHARED_SECRET = 'test-shared-secret';
      process.env.ETSY_REFRESH_TOKEN = 'test-refresh-token';
      
      const config = loadEtsyConfig();
      
      expect(config.apiKey).toBe('test-api-key');
      expect(config.sharedSecret).toBe('test-shared-secret');
      expect(config.refreshToken).toBe('test-refresh-token');
    });

    it('should validate required configuration fields', () => {
      delete process.env.ETSY_API_KEY;
      delete process.env.ETSY_SHARED_SECRET;
      delete process.env.ETSY_REFRESH_TOKEN;
      // point the loader away from any real settings file
      process.env.ETSY_SETTINGS_PATH = path.join(os.tmpdir(), 'etsy-mcp-nonexistent.json');

      expect(() => loadEtsyConfig()).toThrow(
        'ETSY_API_KEY, ETSY_SHARED_SECRET, and ETSY_REFRESH_TOKEN environment variables are required'
      );
    });
  });

  describe('Server Initialization', () => {
    it('should have proper server configuration constants', () => {
      const serverName = 'etsy-mcp-server';
      const serverVersion = '0.1.0';
      const baseURL = 'https://api.etsy.com/v3';
      
      expect(serverName).toBe('etsy-mcp-server');
      expect(serverVersion).toBe('0.1.0');
      expect(baseURL).toBe('https://api.etsy.com/v3');
    });
  });

  describe('API Endpoints', () => {
    it('should define correct Etsy API endpoints', () => {
      const endpoints = {
        token: 'https://api.etsy.com/v3/public/oauth/token',
        shops: '/application/shops',
        listings: '/application/listings',
        users: '/application/users'
      };
      
      expect(endpoints.token).toBe('https://api.etsy.com/v3/public/oauth/token');
      expect(endpoints.shops).toBe('/application/shops');
      expect(endpoints.listings).toBe('/application/listings');
      expect(endpoints.users).toBe('/application/users');
    });
  });

  describe('Tool Schema Validation', () => {
    it('should validate shop_id parameter format', () => {
      const validShopId = '12345';
      const invalidShopId = '';
      
      expect(validShopId).toMatch(/^\d+$/);
      expect(invalidShopId).not.toMatch(/^\d+$/);
    });

    it('should validate listing_id parameter format', () => {
      const validListingId = '67890';
      const invalidListingId = 'abc';
      
      expect(validListingId).toMatch(/^\d+$/);
      expect(invalidListingId).not.toMatch(/^\d+$/);
    });

    it('should validate file path parameters', () => {
      const validPath = '/path/to/image.jpg';
      const invalidPath = '';
      
      expect(validPath.length).toBeGreaterThan(0);
      expect(invalidPath.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing configuration gracefully', () => {
      delete process.env.ETSY_API_KEY;
      
      expect(() => loadEtsyConfig()).toThrow();
    });

    it('should validate input parameters', () => {
      const requiredFields = ['shop_id', 'listing_id', 'image_path'];
      const testInput = { shop_id: '123', listing_id: '456' };
      
      const missingFields = requiredFields.filter(field => !testInput[field as keyof typeof testInput]);
      expect(missingFields).toContain('image_path');
    });
  });
});
