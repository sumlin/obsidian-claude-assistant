import { Plugin, MarkdownView, Modal, Setting, Notice, App, PluginSettingTab } from 'obsidian';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, normalize } from 'path';
import { platform } from 'os';

const execAsync = promisify(exec);

interface ClaudeAssistantSettings {
    claudePath: string;
    nodePath: string;
    logPath: string;
    executionTimeout: number;
}

const DEFAULT_SETTINGS: ClaudeAssistantSettings = {
    claudePath: 'claude',
    nodePath: 'node',
    logPath: '~/.config/obsidian-claude-assistant/logs',
    executionTimeout: 180
}

// Utility functions for cross-platform path handling
function expandTilde(filepath: string): string {
    if (filepath.startsWith('~/')) {
        return join(homedir(), filepath.slice(2));
    }
    return filepath;
}

function normalizePathForPlatform(filepath: string): string {
    const expanded = expandTilde(filepath);
    return normalize(expanded);
}

async function ensureDirectoryExists(dirPath: string): Promise<void> {
    const normalizedPath = normalizePathForPlatform(dirPath);
    try {
        await fs.access(normalizedPath);
    } catch {
        // Directory doesn't exist, create it
        await fs.mkdir(normalizedPath, { recursive: true });
    }
}

export default class ClaudeAssistantPlugin extends Plugin {
    private claudePath: string | null = null;
    settings: ClaudeAssistantSettings;
    private logFilePath: string;
    private activeProcesses: Set<any> = new Set();

    async onload() {
        try {
            await this.loadSettings();
            
            // Set log file path
            try {
                const logDir = normalizePathForPlatform(this.settings.logPath);
                await ensureDirectoryExists(logDir);
                this.logFilePath = join(logDir, 'debug.log');
                await this.log('=== Claude Assistant Plugin Started ===');
            } catch (logError) {
                // Log initialization failed, but plugin can still work
                console.error('Claude Assistant: Failed to initialize logging:', logError);
                console.log('Claude Assistant: Plugin will continue without file logging');
            }
        
        // Use path from settings, if not available - auto detect
        if (this.settings.claudePath && this.settings.claudePath !== 'claude') {
            this.claudePath = this.settings.claudePath;
            console.log('Claude Assistant: Using configured path:', this.claudePath);
        } else {
            // Resolve Claude CLI path during initialization
            this.claudePath = await this.findClaudePath();
            
            // Debug: Output path information to console
            if (this.claudePath) {
                console.log('Claude Assistant: Found Claude CLI at:', this.claudePath);
            } else {
                console.warn('Claude Assistant: Claude CLI not found. Please install it from https://claude.ai/code or specify the path in plugin settings.');
            }
        }
        // Add command to command palette
        this.addCommand({
            id: 'ask-claude',
            name: 'Ask Claude about current note',
            callback: () => this.openQuestionModal(),
        });

        // Add ribbon icon
        this.addRibbonIcon('message-circle', 'Ask Claude', () => {
            this.openQuestionModal();
        });

        // Add settings tab
        this.addSettingTab(new ClaudeAssistantSettingTab(this.app, this));
        } catch (error) {
            console.error('Claude Assistant: Failed to initialize plugin:', error);
            new Notice('Claude Assistant failed to initialize. Please check console for details.');
        }
    }

    onunload() {
        // Clean up any active processes
        if (this.activeProcesses.size > 0) {
            console.log(`Claude Assistant: Cleaning up ${this.activeProcesses.size} active processes`);
            
            for (const child of this.activeProcesses) {
                try {
                    // Try graceful shutdown first
                    child.kill('SIGTERM');
                    
                    // Force kill after 1 second if still running
                    setTimeout(() => {
                        if (!child.killed) {
                            child.kill('SIGKILL');
                        }
                    }, 1000);
                } catch (error) {
                    console.error('Claude Assistant: Error killing process:', error);
                }
            }
            
            this.activeProcesses.clear();
        }
        
        console.log('Claude Assistant: Plugin unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        
        // Migration: ensure new fields exist with defaults if missing
        let needsSave = false;
        
        if (this.settings.nodePath === undefined) {
            this.settings.nodePath = DEFAULT_SETTINGS.nodePath;
            needsSave = true;
            console.log('Claude Assistant: Migrated nodePath setting');
        }
        
        if (this.settings.logPath === undefined) {
            this.settings.logPath = DEFAULT_SETTINGS.logPath;
            needsSave = true;
            console.log('Claude Assistant: Migrated logPath setting');
        }
        
        if (this.settings.executionTimeout === undefined) {
            this.settings.executionTimeout = DEFAULT_SETTINGS.executionTimeout;
            needsSave = true;
            console.log('Claude Assistant: Migrated executionTimeout setting');
        }
        
        if (needsSave) {
            await this.saveSettings();
            console.log('Claude Assistant: Settings migration completed');
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async log(message: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${message}\n`;
        
        try {
            await fs.appendFile(this.logFilePath, logEntry, 'utf8');
            console.log(`Claude Assistant: ${message}`);
        } catch (error) {
            console.error('Failed to write to log file:', error);
            console.log(`Claude Assistant: ${message}`);
        }
    }

    openQuestionModal() {
        // Get active editor
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            new Notice('Please open a markdown note before using Claude Assistant');
            return;
        }

        const editor = activeView.editor;
        const selectedText = editor.getSelection();

        if (selectedText && selectedText.trim()) {
            // If selected text exists: execute immediately
            this.log(`openQuestionModal: Selected text detected (${selectedText.length} chars), executing immediately`);
            this.log(`openQuestionModal: Selected text: "${selectedText.substring(0, 200)}..."`);
            this.processClaudeRequestWithSelection(selectedText);
        } else {
            // If no selected text: show traditional modal
            this.log('openQuestionModal: No selection found, showing modal');
            new QuestionModal(this.app, async (question: string) => {
                await this.processClaudeRequest(question);
            }).open();
        }
    }

    async processClaudeRequestWithSelection(selectedText: string) {
        await this.log(`processClaudeRequestWithSelection started with selected text: ${selectedText.substring(0, 100)}...`);
        
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            await this.log('ERROR: No active markdown view found');
            new Notice('Please open a markdown note before using Claude Assistant');
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            await this.log('ERROR: No active file found');
            new Notice('Please open a file before using Claude Assistant');
            return;
        }

        try {
            // Show loading notification
            const loadingNotice = new Notice('Asking Claude...', 0);
            await this.log('Loading notice displayed');
            
            // Debug information
            await this.log(`Using Claude path: ${this.claudePath}`);
            
            // Get note content
            const noteContent = await this.app.vault.read(activeFile);
            await this.log(`Note content length: ${noteContent.length} characters`);
            await this.log(`Note content preview: ${noteContent.substring(0, 200)}...`);
            await this.log(`Selected text as question: "${selectedText}"`);
            
            // Execute Claude command (use selected text as question)
            await this.log('Starting Claude command execution...');
            const result = await this.executeClaudeCommand(noteContent, selectedText);
            await this.log(`Claude command completed. Result length: ${result.length} characters`);
            await this.log(`Claude response preview: ${result.substring(0, 300)}...`);
            
            // Remove loading notification
            loadingNotice.hide();
            await this.log('Loading notice hidden');
            
            // Replace selection with Claude response
            const editor = activeView.editor;
            editor.replaceSelection(result);
            await this.log('Selected text replaced with Claude response');
            
            new Notice(`Claude response replaced selection (${result.length} chars): ${result.substring(0, 50)}${result.length > 50 ? '...' : ''}`, 5000);
            await this.log('processClaudeRequestWithSelection completed successfully');
        } catch (error) {
            await this.log(`ERROR in processClaudeRequestWithSelection: ${error.message}`);
            await this.log(`ERROR stack: ${error.stack}`);
            new Notice(`Claude Assistant Error: ${error.message}. Please check the plugin settings and ensure Claude CLI is properly installed.`);
            console.error('Claude Assistant Error:', error);
            console.error('Claude Assistant: Current path was:', this.claudePath);
        }
    }

    async processClaudeRequest(question: string) {
        await this.log(`processClaudeRequest started with question: ${question.substring(0, 100)}...`);
        
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            await this.log('ERROR: No active markdown view found');
            new Notice('Please open a markdown note before using Claude Assistant');
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            await this.log('ERROR: No active file found');
            new Notice('Please open a file before using Claude Assistant');
            return;
        }

        try {
            // Show loading notification
            const loadingNotice = new Notice('Asking Claude...', 0);
            await this.log('Loading notice displayed');
            
            // Debug information
            await this.log(`Using Claude path: ${this.claudePath}`);
            
            // Get note content
            const noteContent = await this.app.vault.read(activeFile);
            await this.log(`Note content length: ${noteContent.length} characters`);
            await this.log(`Note content preview: ${noteContent.substring(0, 200)}...`);
            await this.log(`User question: "${question}"`);
            
            // Execute Claude command
            await this.log('Starting Claude command execution...');
            const result = await this.executeClaudeCommand(noteContent, question);
            await this.log(`Claude command completed. Result length: ${result.length} characters`);
            await this.log(`Claude response preview: ${result.substring(0, 300)}...`);
            
            // Remove loading notification
            loadingNotice.hide();
            await this.log('Loading notice hidden');
            
            // Insert result at cursor position
            const editor = activeView.editor;
            const cursor = editor.getCursor();
            editor.replaceRange('\n\n' + result + '\n\n', cursor);
            await this.log('Result inserted at cursor position');
            
            new Notice(`Claude response inserted (${result.length} chars): ${result.substring(0, 50)}${result.length > 50 ? '...' : ''}`, 5000);
            await this.log('processClaudeRequest completed successfully');
        } catch (error) {
            await this.log(`ERROR in processClaudeRequest: ${error.message}`);
            await this.log(`ERROR stack: ${error.stack}`);
            new Notice(`Claude Assistant Error: ${error.message}. Please check the plugin settings and ensure Claude CLI is properly installed.`);
            console.error('Claude Assistant Error:', error);
            console.error('Claude Assistant: Current path was:', this.claudePath);
        }
    }

    async findClaudePath(): Promise<string | null> {
        const homeDir = homedir();
        const isWindows = platform() === 'win32';
        
        const possiblePaths: string[] = ['claude']; // claude in PATH
        
        if (isWindows) {
            // Windows-specific paths
            possiblePaths.push(
                join(process.env.APPDATA || '', 'claude', 'claude.exe'),
                join(process.env.LOCALAPPDATA || '', 'claude', 'claude.exe'),
                join(process.env.ProgramFiles || '', 'claude', 'claude.exe'),
                join(homeDir, '.claude', 'claude.exe'),
                join(homeDir, 'AppData', 'Local', 'claude', 'claude.exe')
            );
        } else {
            // Unix-like paths (macOS, Linux)
            possiblePaths.push(
                '/usr/local/bin/claude',
                '/usr/bin/claude',
                '/opt/homebrew/bin/claude',
                join(homeDir, '.claude', 'local', 'claude'),
                join(homeDir, '.claude', 'local', 'node_modules', '.bin', 'claude'),
                join(homeDir, '.config', 'claude', 'claude'),
                join(homeDir, '.local', 'bin', 'claude')
            );
        }

        console.log('Claude Assistant: Searching for Claude CLI...');

        for (const path of possiblePaths) {
            try {
                console.log(`Claude Assistant: Checking path: ${path}`);
                
                if (path === 'claude') {
                    // Check command in PATH
                    try {
                        const searchCommand = isWindows ? 'where' : 'which';
                        const { stdout } = await execAsync(`${searchCommand} claude`);
                        const resolvedPath = stdout.trim().split('\n')[0]; // Windows may return multiple paths
                        if (resolvedPath) {
                            console.log(`Claude Assistant: Found via ${searchCommand}: ${resolvedPath}`);
                            // Actual execution test
                            await this.testClaudePath(resolvedPath);
                            return resolvedPath;
                        }
                    } catch (error) {
                        console.log(`Claude Assistant: ${isWindows ? 'where' : 'which'} claude failed: ${error.message}`);
                    }
                } else {
                    // Check file existence
                    await fs.access(path);
                    console.log(`Claude Assistant: File exists: ${path}`);
                    // Actual execution test
                    await this.testClaudePath(path);
                    return path;
                }
            } catch (error) {
                console.log(`Claude Assistant: Path ${path} failed: ${error.message}`);
                continue;
            }
        }

        console.warn('Claude Assistant: No valid Claude CLI path found');
        return null;
    }

    async testClaudePath(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(path, ['--version'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 5000
            });

            child.on('close', (code) => {
                if (code === 0) {
                    console.log(`Claude Assistant: Successfully tested path: ${path}`);
                    resolve();
                } else {
                    reject(new Error(`Test failed with exit code ${code}`));
                }
            });

            child.on('error', (error) => {
                reject(error);
            });

            setTimeout(() => {
                child.kill();
                reject(new Error('Test timeout'));
            }, 5000);
        });
    }

    async executeClaudeCommand(noteContent: string, question: string): Promise<string> {
        await this.log('executeClaudeCommand: Starting execution');
        
        // Construct prompt
        const prompt = `${noteContent}\n\n---------\n\n${question}`;
        await this.log(`executeClaudeCommand: Prompt length: ${prompt.length} characters`);
        await this.log(`executeClaudeCommand: Prompt preview: ${prompt.substring(0, 200)}...`);
        
        // Set environment variables appropriately
        const processEnv = {
            ...process.env
        };
        
        // Execute Claude CLI
        const claudeCommand = this.claudePath || this.settings.claudePath || 'claude';
        const nodeCommand = this.settings.nodePath || 'node';
        
        // Determine if we need to use Node.js to run the command
        let finalCommand: string;
        let args: string[];
        
        if (claudeCommand.endsWith('.js')) {
            // JavaScript file, use Node.js
            finalCommand = nodeCommand;
            args = [claudeCommand, '--verbose', '--print'];
        } else {
            // Assume it's an executable
            finalCommand = claudeCommand;
            args = ['--verbose', '--print'];
        }
        
        await this.log(`executeClaudeCommand: Command: ${finalCommand}`);
        await this.log(`executeClaudeCommand: Args: ${JSON.stringify(args)}`);
        await this.log(`executeClaudeCommand: Working directory: ${homedir()}`);
        
        return new Promise(async (resolve, reject) => {
            await this.log('executeClaudeCommand: Creating spawn process...');
            
            let statusInterval: NodeJS.Timeout | null = null;
            let timeout: NodeJS.Timeout | null = null;
            
            // Cleanup function
            const cleanup = () => {
                if (statusInterval) {
                    clearInterval(statusInterval);
                    statusInterval = null;
                }
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
            };
            
            // Spawn using the same method as Shell commands plugin
            const child = spawn(finalCommand, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: processEnv,
                cwd: homedir() // Explicitly set working directory
            });

            await this.log(`executeClaudeCommand: Spawn created, PID: ${child.pid}`);
            
            // Track active process
            this.activeProcesses.add(child);

            let stdout = '';
            let stderr = '';

            // Set utf8 encoding (same as Shell commands plugin)
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');

            // Set all event handlers first
            child.on('spawn', async () => {
                await this.log('executeClaudeCommand: Process spawned successfully');
            });

            child.on('error', async (error) => {
                cleanup(); // Clean up intervals and timeouts
                this.activeProcesses.delete(child); // Remove from active processes
                await this.log(`executeClaudeCommand: Process error: ${error.message}`);
                await this.log(`executeClaudeCommand: Error stack: ${error.stack}`);
                reject(new Error(`Claude CLI execution error: ${error.message}`));
            });

            child.stdout?.on('data', async (data) => {
                const dataStr = data.toString();
                stdout += dataStr;
                await this.log(`executeClaudeCommand: stdout data received: ${dataStr.length} chars`);
                await this.log(`executeClaudeCommand: stdout preview: ${dataStr.substring(0, 200)}...`);
            });

            child.stderr?.on('data', async (data) => {
                const dataStr = data.toString();
                stderr += dataStr;
                await this.log(`executeClaudeCommand: stderr data received: ${dataStr.length} chars`);
                await this.log(`executeClaudeCommand: stderr content: ${dataStr}`);
            });

            child.on('close', async (code) => {
                cleanup(); // Clean up intervals and timeouts
                this.activeProcesses.delete(child); // Remove from active processes
                await this.log(`executeClaudeCommand: Process closed with code: ${code}`);
                await this.log(`executeClaudeCommand: Final stdout length: ${stdout.length}`);
                await this.log(`executeClaudeCommand: Final stderr length: ${stderr.length}`);
                
                if (code === 0) {
                    await this.log('executeClaudeCommand: Success, resolving with stdout');
                    resolve(stdout.trim());
                } else {
                    await this.log(`executeClaudeCommand: Failed with exit code ${code}`);
                    reject(new Error(`Claude CLI failed with exit code ${code}: ${stderr}`));
                }
            });

            // For debugging: periodic status check
            statusInterval = setInterval(async () => {
                await this.log(`executeClaudeCommand: Status check - Process exists: ${child.pid}, killed: ${child.killed}, connected: ${child.connected}`);
            }, 5000);

            // Send prompt to standard input
            if (child.stdin) {
                await this.log('executeClaudeCommand: Writing prompt to stdin...');
                child.stdin.write(prompt);
                child.stdin.end();
                await this.log('executeClaudeCommand: Prompt written to stdin');
            } else {
                await this.log('executeClaudeCommand: ERROR - stdin not available');
                reject(new Error('stdin not available'));
                return;
            }

            // Timeout setting
            const timeoutMs = this.settings.executionTimeout * 1000;
            timeout = setTimeout(() => {
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 1000);
                cleanup();
                reject(new Error(`Claude CLI execution timed out after ${this.settings.executionTimeout} seconds. You can increase the timeout in plugin settings.`));
            }, timeoutMs);
            
            await this.log('executeClaudeCommand: Promise setup complete, waiting for process...');
        });
    }

}

class QuestionModal extends Modal {
    private question: string = '';
    private onSubmit: (question: string) => void;

    constructor(app: App, onSubmit: (question: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Ask Claude' });

        new Setting(contentEl)
            .setName('Question')
            .setDesc('Enter your question about the current note')
            .addTextArea(text => {
                text.setPlaceholder('What would you like to ask Claude about this note?')
                    .setValue(this.question)
                    .onChange(value => this.question = value);
                text.inputEl.rows = 4;
                text.inputEl.cols = 50;
                // Set focus
                setTimeout(() => text.inputEl.focus(), 100);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Ask Claude')
                .setCta()
                .onClick(() => {
                    if (this.question.trim()) {
                        this.close();
                        this.onSubmit(this.question);
                    } else {
                        new Notice('Please enter a question');
                    }
                }));

        // Support submission with Enter key
        this.scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
            if (this.question.trim()) {
                this.close();
                this.onSubmit(this.question);
            }
            return false;
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ClaudeAssistantSettingTab extends PluginSettingTab {
    plugin: ClaudeAssistantPlugin;

    constructor(app: App, plugin: ClaudeAssistantPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Claude Assistant Settings' });

        new Setting(containerEl)
            .setName('Claude CLI Path')
            .setDesc('Path to Claude CLI executable. Leave as "claude" to use PATH, or specify full path like "/Users/username/.claude/local/claude"')
            .addText(text => text
                .setPlaceholder('/Users/username/.claude/local/claude')
                .setValue(this.plugin.settings.claudePath)
                .onChange(async (value) => {
                    this.plugin.settings.claudePath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Node.js Path')
            .setDesc('Path to Node.js executable (use "node" for system PATH)')
            .addText(text => text
                .setPlaceholder('node')
                .setValue(this.plugin.settings.nodePath)
                .onChange(async (value) => {
                    this.plugin.settings.nodePath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Log Directory Path')
            .setDesc('Directory for debug logs')
            .addText(text => text
                .setPlaceholder('~/.config/obsidian-claude-assistant/logs')
                .setValue(this.plugin.settings.logPath)
                .onChange(async (value) => {
                    this.plugin.settings.logPath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Execution Timeout')
            .setDesc('Timeout for Claude CLI execution in seconds')
            .addText(text => text
                .setPlaceholder('180')
                .setValue(String(this.plugin.settings.executionTimeout))
                .onChange(async (value) => {
                    const timeout = parseInt(value, 10);
                    if (!isNaN(timeout) && timeout >= 10) {
                        this.plugin.settings.executionTimeout = timeout;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Test Claude CLI')
            .setDesc('Test if Claude CLI is accessible using the same method as actual execution')
            .addButton(button => button
                .setButtonText('Test Connection')
                .onClick(async () => {
                    button.setButtonText('Testing...');
                    
                    const testResults = {
                        claudeCLI: { passed: false, message: '', error: null as any },
                        logDirectory: { passed: false, message: '', error: null as any },
                        nodejs: { passed: false, message: '', error: null as any }
                    };
                    
                    // Test 1: Claude CLI
                    try {
                        button.setButtonText('Testing Claude CLI...');
                        const claudeResult = await this.testClaudeExecution();
                        testResults.claudeCLI.passed = true;
                        testResults.claudeCLI.message = 'Working ✓';
                        console.log('Claude Assistant: Claude CLI test passed');
                    } catch (error) {
                        testResults.claudeCLI.passed = false;
                        testResults.claudeCLI.message = `Failed: ${error.message}`;
                        testResults.claudeCLI.error = error;
                        console.error('Claude Assistant: Claude CLI test failed:', error);
                    }
                    
                    // Test 2: Log Directory
                    try {
                        button.setButtonText('Testing log directory...');
                        const logDir = normalizePathForPlatform(this.plugin.settings.logPath);
                        
                        // First, try to create the directory if it doesn't exist
                        try {
                            await ensureDirectoryExists(logDir);
                            console.log('Claude Assistant: Log directory created/verified');
                        } catch (createError) {
                            console.error('Claude Assistant: Failed to create log directory:', createError);
                            throw new Error(`Cannot create directory: ${createError.message}`);
                        }
                        
                        // Then verify it exists and is accessible
                        try {
                            await fs.access(logDir, fs.constants.W_OK);
                            testResults.logDirectory.passed = true;
                            testResults.logDirectory.message = `${logDir} ✓`;
                            console.log('Claude Assistant: Log directory test passed');
                        } catch (accessError) {
                            throw new Error(`Directory exists but not writable: ${accessError.message}`);
                        }
                    } catch (error) {
                        testResults.logDirectory.passed = false;
                        testResults.logDirectory.message = `Failed: ${error.message}`;
                        testResults.logDirectory.error = error;
                        console.error('Claude Assistant: Log directory test failed:', error);
                    }
                    
                    // Test 3: Node.js
                    try {
                        button.setButtonText('Testing Node.js...');
                        const nodeTest = await this.testCommand(this.plugin.settings.nodePath || 'node', ['--version']);
                        testResults.nodejs.passed = true;
                        testResults.nodejs.message = `${nodeTest.trim()} ✓`;
                        console.log('Claude Assistant: Node.js test passed');
                    } catch (error) {
                        testResults.nodejs.passed = false;
                        testResults.nodejs.message = `Failed: ${error.message}`;
                        testResults.nodejs.error = error;
                        console.error('Claude Assistant: Node.js test failed:', error);
                    }
                    
                    // Display results
                    const allPassed = testResults.claudeCLI.passed && 
                                    testResults.logDirectory.passed && 
                                    testResults.nodejs.passed;
                    
                    if (allPassed) {
                        new Notice(`✅ All tests passed!\n` +
                                 `Claude CLI: ${testResults.claudeCLI.message}\n` +
                                 `Log directory: ${testResults.logDirectory.message}\n` +
                                 `Node.js: ${testResults.nodejs.message}`, 8000);
                    } else {
                        let failedTests = [];
                        let detailedErrors = [];
                        
                        if (!testResults.claudeCLI.passed) {
                            failedTests.push('Claude CLI');
                            detailedErrors.push(`Claude CLI: ${testResults.claudeCLI.message}`);
                        }
                        if (!testResults.logDirectory.passed) {
                            failedTests.push('Log Directory');
                            detailedErrors.push(`Log Directory: ${testResults.logDirectory.message}`);
                        }
                        if (!testResults.nodejs.passed) {
                            failedTests.push('Node.js');
                            detailedErrors.push(`Node.js: ${testResults.nodejs.message}`);
                        }
                        
                        new Notice(`❌ Some tests failed:\n\n` +
                                 `✓ Passed: ${3 - failedTests.length} / 3\n` +
                                 `✗ Failed: ${failedTests.join(', ')}\n\n` +
                                 `Details:\n${detailedErrors.join('\n')}\n\n` +
                                 `Please check the failed components`, 15000);
                    }
                    
                    button.setButtonText('Test Connection');
                }));

        // Debug test functionality (minimal necessary)
        containerEl.createEl('h3', { text: 'Debug Commands' });
        
        const debugCommands = [
            { name: 'Test Node.js access', command: this.plugin.settings.nodePath || 'node', args: ['--version'] },
            { name: 'Test Claude CLI direct', command: this.plugin.settings.claudePath || 'claude', args: ['--version'] }
        ];

        debugCommands.forEach(cmd => {
            new Setting(containerEl)
                .setName(cmd.name)
                .addButton(button => button
                    .setButtonText('Test')
                    .onClick(async () => {
                        button.setButtonText('Testing...');
                        try {
                            const result = await this.testCommand(cmd.command, cmd.args);
                            new Notice(`✅ ${cmd.name} success`);
                            console.log(`${cmd.name} result:`, result);
                            button.setButtonText('Test');
                        } catch (error) {
                            new Notice(`❌ ${cmd.name} failed: ${error.message}`);
                            console.error(`${cmd.name} error:`, error);
                            button.setButtonText('Test');
                        }
                    }))
        });

        // Explanation about macOS permissions
        containerEl.createEl('h3', { text: 'macOS Permissions' });
        containerEl.createEl('p', { 
            text: 'If Claude CLI is not found, you may need to grant Obsidian additional permissions:'
        });
        
        const permissionsList = containerEl.createEl('ul');
        permissionsList.createEl('li', { text: 'System Preferences > Privacy & Security > Full Disk Access > Add Obsidian' });
        permissionsList.createEl('li', { text: 'System Preferences > Privacy & Security > Files and Folders > Grant Home folder access to Obsidian' });
        
        containerEl.createEl('p', { 
            text: 'After changing permissions, restart Obsidian and try again.'
        });
    }

    async testClaudeExecution(): Promise<string> {
        await this.plugin.log('testClaudeExecution: Starting test with actual prompt');
        
        const testPrompt = 'Hello';
        await this.plugin.log(`testClaudeExecution: Test input: "${testPrompt}"`);
        
        try {
            // Test using actual executeClaudeCommand
            const result = await this.plugin.executeClaudeCommand('', testPrompt);
            await this.plugin.log(`testClaudeExecution: Test output: "${result}"`);
            await this.plugin.log('testClaudeExecution: Test completed successfully');
            return result;
        } catch (error) {
            await this.plugin.log(`testClaudeExecution: Test failed with error: ${error.message}`);
            throw error;
        }
    }

    async testCommand(command: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
                timeout: 10000
            });

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout || stderr); // stderr may also be treated as normal output
                } else {
                    reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
                }
            });

            child.on('error', (error) => {
                reject(new Error(`Command error: ${error.message}`));
            });

            setTimeout(() => {
                child.kill();
                reject(new Error('Command timeout'));
            }, 10000);
        });
    }
}