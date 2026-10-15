# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-07-16

Standalone continuation of [profplum700/etsy-mcp-server](https://github.com/profplum700/etsy-mcp-server), updated for Etsy API changes through 2026.

### Added
- `getShopShippingProfiles`, `getShopReturnPolicies` tools
- `getShopReadinessStateDefinitions`, `createShopReadinessStateDefinition` tools for processing profiles (`readiness_state_id` is required for physical listings since 2025-06)
- `createDraftListing`: `tags`, `materials`, `shipping_profile_id`, `return_policy_id`, `readiness_state_id`, `shop_section_id`, `type` fields
- `updateListing`: `tags`, `materials`, `shipping_profile_id`, `shop_section_id` fields
- Unit tests for listing and shop handlers

### Fixed
- **`npm test` no longer deletes a real `etsy_mcp_settings.json` from the project root.** Previously both the config loader (under `NODE_ENV=test`) and two test files unlinked the developer's actual credentials file. The settings path is now overridable via `ETSY_SETTINGS_PATH` and tests run against a temp directory.
- `x-api-key` header now sent as `keystring:sharedSecret` (required by Etsy since 2026-02), both in the server and the refresh-token helper
- `tags`/`materials` arrays encoded as comma-separated strings as Etsy's form-encoded API expects
- `form-data` declared as a direct dependency (was relied on transitively)

### Changed
- Fixed configuration validation test for missing environment variables
- Improved error handling and validation

## [1.0.0] - 2024-12-XX

### Added
- Initial public release of Etsy MCP Server
- Complete MCP server implementation for Etsy API integration
- OAuth 2.0 authentication with refresh token support
- Shop management tools (getMe, getShop, getShopSections)
- Listing management tools (create, update, images, inventory)
- Seller taxonomy tools for product categorization
- Docker containerization support
- Comprehensive documentation and examples
- Interactive OAuth token helper script
- Full test suite with 98%+ pass rate
- CI/CD pipeline with automated testing
- TypeScript support with strict type checking

### Security
- Secure OAuth implementation with token refresh
- Environment variable configuration support
- Credential validation and error handling
- Non-root Docker container execution

---

**Note**: This changelog will be updated with each release. For detailed commit history, see the Git log.