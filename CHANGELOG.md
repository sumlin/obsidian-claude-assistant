# Changelog

All notable changes to the Obsidian Claude Assistant plugin will be documented in this file.

## [1.1.0] - 2025-01-16

### Added
- New settings for Node.js path configuration
- Configurable log directory path
- Adjustable execution timeout (default: 180 seconds)
- Cross-platform support for Windows and Linux
- Improved error messages with actionable guidance
- Enhanced test connection functionality with detailed results
- Process cleanup on plugin unload

### Changed
- Replaced all hardcoded paths with dynamic, user-configurable paths
- Improved path handling for cross-platform compatibility
- Enhanced error handling throughout the plugin
- Updated settings UI with new configuration options
- Better timeout handling with configurable values
- Translated all Japanese comments to English for better international collaboration
- Improved code readability and maintainability

### Fixed
- Fixed hardcoded paths that only worked on developer's machine
- Fixed memory leaks from uncleared intervals
- Fixed missing timeout functionality
- Fixed process cleanup issues
- Fixed Claude CLI path being ignored from settings
- Fixed "Failed to resolve module specifier 'fs/promises'" error in Obsidian environment
- Fixed Test Connection button to show individual test results for better debugging
- Fixed log directory test to create directory before verification

### Security
- Added proper process cleanup to prevent zombie processes
- Improved error handling to prevent crashes

## [1.0.0] - Initial Release

### Added
- Basic Claude CLI integration
- Two operation modes: traditional modal and instant selection-based
- Cursor position insertion
- Selection replacement
- Comprehensive logging
- Progress tracking
- Debug tools
