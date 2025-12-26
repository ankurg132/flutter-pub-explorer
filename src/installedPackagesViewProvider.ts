import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PubDevApi, PackageDetails, PackageScore } from './pubDevApi';

interface InstalledPackage {
    name: string;
    currentVersion: string;
    latestVersion?: string;
    isDeprecated: boolean;
    isDiscontinued: boolean;
    isOutdated: boolean;
    details?: PackageDetails;
    score?: PackageScore;
}

export class InstalledPackagesViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'flutterPubExplorer.installedPackagesView';

    private _view?: vscode.WebviewView;
    private readonly api: PubDevApi;
    private installedPackages: InstalledPackage[] = [];
    private isLoading: boolean = false;
    private fileWatcher?: vscode.FileSystemWatcher;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.api = new PubDevApi();
        this.setupFileWatcher();
    }

    private setupFileWatcher(): void {
        // Watch for changes to pubspec.yaml and pubspec.lock
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/pubspec.{yaml,lock}');

        const refreshDebounced = this.debounce(() => {
            if (this._view?.visible) {
                this.loadInstalledPackages();
            } else {
                // Clear cache so it reloads when view becomes visible
                this.installedPackages = [];
            }
        }, 1000);

        this.fileWatcher.onDidChange(refreshDebounced);
        this.fileWatcher.onDidCreate(refreshDebounced);
        this.fileWatcher.onDidDelete(refreshDebounced);
    }

    private debounce(func: () => void, wait: number): () => void {
        let timeout: NodeJS.Timeout | undefined;
        return () => {
            if (timeout) {
                clearTimeout(timeout);
            }
            timeout = setTimeout(func, wait);
        };
    }

    public dispose(): void {
        this.fileWatcher?.dispose();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'refresh':
                    await this.loadInstalledPackages();
                    break;
                case 'updatePackage':
                    await this.updatePackage(message.packageName, message.version);
                    break;
                case 'removePackage':
                    await this.removePackage(message.packageName);
                    break;
                case 'getDetails':
                    await this.getPackageDetails(message.packageName);
                    break;
                case 'viewOnPubDev':
                    vscode.env.openExternal(vscode.Uri.parse(`https://pub.dev/packages/${message.packageName}`));
                    break;
            }
        });

        // Restore cached data or reload when view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                if (this.installedPackages.length > 0) {
                    this.updateView({ packages: this.installedPackages });
                } else {
                    this.loadInstalledPackages();
                }
            }
        });

        this.loadInstalledPackages();
    }

    private async loadInstalledPackages(): Promise<void> {
        if (this.isLoading) {
            return;
        }

        this.isLoading = true;
        this.updateView({ loading: true });

        try {
            const pubspecPath = await this.findPubspecYaml();
            if (!pubspecPath) {
                this.updateView({ error: 'No pubspec.yaml found in workspace' });
                return;
            }

            const pubspecContent = fs.readFileSync(pubspecPath, 'utf-8');
            const dependencies = this.parsePubspecDependencies(pubspecContent);

            if (dependencies.length === 0) {
                this.updateView({ packages: [], empty: true });
                return;
            }

            // Fetch details for all packages in parallel
            const packagePromises = dependencies.map(async (dep) => {
                try {
                    const [details, score] = await Promise.all([
                        this.api.getPackageDetails(dep.name).catch(() => null),
                        this.api.getPackageScore(dep.name).catch(() => null)
                    ]);

                    const latestVersion = details?.latest?.version;
                    const isDiscontinued = score?.tags?.includes('is:discontinued') || false;
                    const isDeprecated = score?.tags?.includes('is:deprecated') || false;
                    const isOutdated = latestVersion ? this.isVersionOutdated(dep.version, latestVersion) : false;

                    return {
                        name: dep.name,
                        currentVersion: dep.version,
                        latestVersion,
                        isDeprecated,
                        isDiscontinued,
                        isOutdated,
                        details,
                        score
                    } as InstalledPackage;
                } catch {
                    return {
                        name: dep.name,
                        currentVersion: dep.version,
                        isDeprecated: false,
                        isDiscontinued: false,
                        isOutdated: false
                    } as InstalledPackage;
                }
            });

            this.installedPackages = await Promise.all(packagePromises);

            // Sort: deprecated first, then outdated, then alphabetical
            this.installedPackages.sort((a, b) => {
                if (a.isDeprecated !== b.isDeprecated) return a.isDeprecated ? -1 : 1;
                if (a.isDiscontinued !== b.isDiscontinued) return a.isDiscontinued ? -1 : 1;
                if (a.isOutdated !== b.isOutdated) return a.isOutdated ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            this.updateView({ packages: this.installedPackages });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load installed packages: ${error}`);
            this.updateView({ error: 'Failed to load installed packages' });
        } finally {
            this.isLoading = false;
        }
    }

    private async findPubspecYaml(): Promise<string | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }

        // Check each workspace folder for pubspec.yaml
        for (const folder of workspaceFolders) {
            const pubspecPath = path.join(folder.uri.fsPath, 'pubspec.yaml');
            if (fs.existsSync(pubspecPath)) {
                return pubspecPath;
            }
        }

        return null;
    }

    private parsePubspecDependencies(content: string): Array<{ name: string; version: string }> {
        const dependencies: Array<{ name: string; version: string }> = [];
        const lines = content.split('\n');
        let inDependencies = false;
        let inDevDependencies = false;
        let currentIndent = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue;
            }

            // Check for section headers
            if (line.match(/^dependencies:\s*$/)) {
                inDependencies = true;
                inDevDependencies = false;
                currentIndent = 0;
                continue;
            }

            if (line.match(/^dev_dependencies:\s*$/)) {
                inDependencies = false;
                inDevDependencies = true;
                currentIndent = 0;
                continue;
            }

            // Check if we've exited the dependencies sections (new top-level key)
            if (!line.startsWith(' ') && !line.startsWith('\t') && trimmedLine.endsWith(':')) {
                inDependencies = false;
                inDevDependencies = false;
                continue;
            }

            // Parse dependencies
            if (inDependencies || inDevDependencies) {
                // Match package: version pattern
                const simpleMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*[\^~]?(\d+\.\d+\.\d+[^\s]*)\s*$/i);
                if (simpleMatch) {
                    dependencies.push({
                        name: simpleMatch[1],
                        version: simpleMatch[2]
                    });
                    continue;
                }

                // Match package with caret or tilde (e.g., "package: ^1.0.0")
                const caretMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*["']?[\^~]?(\d+\.\d+\.\d+[^"'\s]*)["']?\s*$/i);
                if (caretMatch) {
                    dependencies.push({
                        name: caretMatch[1],
                        version: caretMatch[2]
                    });
                    continue;
                }

                // Match package: any or package without version
                const anyMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*any\s*$/i);
                if (anyMatch) {
                    dependencies.push({
                        name: anyMatch[1],
                        version: 'any'
                    });
                    continue;
                }

                // Match package with just a name (git, path, or SDK dependency follows on next lines)
                const packageNameOnlyMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*$/i);
                if (packageNameOnlyMatch) {
                    // Check next line for path/git/sdk
                    const nextLine = lines[i + 1]?.trim() || '';
                    if (nextLine.startsWith('path:') || nextLine.startsWith('git:') || nextLine.startsWith('sdk:')) {
                        dependencies.push({
                            name: packageNameOnlyMatch[1],
                            version: nextLine.startsWith('path:') ? 'path' :
                                     nextLine.startsWith('git:') ? 'git' : 'sdk'
                        });
                    }
                    continue;
                }
            }
        }

        // Filter out flutter and flutter_test as they're SDK packages
        return dependencies.filter(d =>
            d.name !== 'flutter' &&
            d.name !== 'flutter_test' &&
            d.name !== 'flutter_localizations' &&
            d.version !== 'sdk'
        );
    }

    private isVersionOutdated(currentVersion: string, latestVersion: string): boolean {
        if (!currentVersion || !latestVersion || currentVersion === 'any' ||
            currentVersion === 'path' || currentVersion === 'git') {
            return false;
        }

        // Extract version numbers
        const current = currentVersion.replace(/[\^~>=<\s"']/g, '').split('.').map(Number);
        const latest = latestVersion.replace(/[\^~>=<\s"']/g, '').split('.').map(Number);

        // Compare major, minor, patch
        for (let i = 0; i < 3; i++) {
            const c = current[i] || 0;
            const l = latest[i] || 0;
            if (l > c) return true;
            if (c > l) return false;
        }

        return false;
    }

    private async getPackageDetails(packageName: string): Promise<void> {
        try {
            const [details, score] = await Promise.all([
                this.api.getPackageDetails(packageName),
                this.api.getPackageScore(packageName).catch(() => null)
            ]);

            const installedPkg = this.installedPackages.find(p => p.name === packageName);

            this._view?.webview.postMessage({
                command: 'packageDetails',
                details,
                score,
                currentVersion: installedPkg?.currentVersion
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get package details: ${error}`);
        }
    }

    private async updatePackage(packageName: string, version?: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        let workspaceFolder = workspaceFolders[0];

        if (workspaceFolders.length > 1) {
            const selected = await vscode.window.showQuickPick(
                workspaceFolders.map(f => ({ label: f.name, folder: f })),
                { placeHolder: 'Select the Flutter project' }
            );
            if (!selected) {
                return;
            }
            workspaceFolder = selected.folder;
        }

        const command = version
            ? `flutter pub add ${packageName}:${version}`
            : `flutter pub add ${packageName}`;

        const terminal = vscode.window.createTerminal({
            name: 'Flutter Pub Update',
            cwd: workspaceFolder.uri.fsPath
        });

        terminal.show();
        terminal.sendText(command);

        vscode.window.showInformationMessage(`Running: ${command}`);
    }

    private async removePackage(packageName: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        let workspaceFolder = workspaceFolders[0];

        if (workspaceFolders.length > 1) {
            const selected = await vscode.window.showQuickPick(
                workspaceFolders.map(f => ({ label: f.name, folder: f })),
                { placeHolder: 'Select the Flutter project' }
            );
            if (!selected) {
                return;
            }
            workspaceFolder = selected.folder;
        }

        const command = `flutter pub remove ${packageName}`;

        const terminal = vscode.window.createTerminal({
            name: 'Flutter Pub Remove',
            cwd: workspaceFolder.uri.fsPath
        });

        terminal.show();
        terminal.sendText(command);

        vscode.window.showInformationMessage(`Running: ${command}`);
    }

    private updateView(data: { packages?: InstalledPackage[]; loading?: boolean; error?: string; empty?: boolean }): void {
        this._view?.webview.postMessage({
            command: 'update',
            ...data
        });
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Installed Packages</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 10px;
        }

        .header {
            position: sticky;
            top: 0;
            background-color: var(--vscode-sideBar-background);
            padding-bottom: 10px;
            z-index: 100;
        }

        .header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .header-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            letter-spacing: 0.5px;
        }

        .refresh-btn {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            font-size: 11px;
            border: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .refresh-btn:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .stats-bar {
            display: flex;
            gap: 12px;
            padding: 8px 12px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }

        .stat {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .stat-value {
            font-weight: bold;
            color: var(--vscode-foreground);
        }

        .stat-deprecated .stat-value {
            color: var(--vscode-errorForeground);
        }

        .stat-discontinued .stat-value {
            color: #d32f2f;
        }

        .stat-outdated .stat-value {
            color: var(--vscode-editorWarning-foreground);
        }

        .package-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .package-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            cursor: pointer;
            transition: border-color 0.2s, background-color 0.2s;
        }

        .package-card:hover {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-list-hoverBackground);
        }

        .package-card.deprecated {
            border-left: 3px solid var(--vscode-errorForeground);
        }

        .package-card.outdated {
            border-left: 3px solid var(--vscode-editorWarning-foreground);
        }

        .package-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 6px;
            gap: 8px;
        }

        .package-name-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .package-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            font-size: 13px;
        }

        .status-icon {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 3px;
        }

        .status-icon.error {
            background-color: rgba(255, 0, 0, 0.15);
            color: var(--vscode-errorForeground);
        }

        .status-icon.warning {
            background-color: rgba(255, 200, 0, 0.15);
            color: var(--vscode-editorWarning-foreground);
        }

        .version-info {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
        }

        .current-version {
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            padding: 2px 6px;
            border-radius: 3px;
        }

        .version-arrow {
            color: var(--vscode-descriptionForeground);
        }

        .latest-version {
            color: var(--vscode-textLink-foreground);
            background-color: rgba(0, 122, 204, 0.15);
            padding: 2px 6px;
            border-radius: 3px;
        }

        .package-actions {
            display: flex;
            gap: 6px;
            margin-top: 10px;
        }

        .action-btn {
            padding: 4px 10px;
            font-size: 11px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .update-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .update-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .remove-btn {
            background-color: transparent;
            color: var(--vscode-errorForeground);
            border: 1px solid var(--vscode-errorForeground);
        }

        .remove-btn:hover {
            background-color: rgba(255, 0, 0, 0.1);
        }

        .view-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .view-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .loading {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .spinner {
            border: 2px solid var(--vscode-panel-border);
            border-top: 2px solid var(--vscode-button-background);
            border-radius: 50%;
            width: 24px;
            height: 24px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .error {
            color: var(--vscode-errorForeground);
            text-align: center;
            padding: 40px 20px;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-icon {
            font-size: 32px;
            margin-bottom: 10px;
            opacity: 0.5;
        }

        /* Details screen styles */
        .details-screen {
            display: none;
        }

        .details-screen.active {
            display: block;
        }

        .list-screen.hidden {
            display: none;
        }

        .back-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 15px;
        }

        .back-btn {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            background: none;
            border: 1px solid var(--vscode-button-secondaryBackground);
            color: var(--vscode-foreground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .back-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .details-title {
            font-size: 16px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }

        .details-content {
            padding: 10px 0;
        }

        .details-section {
            margin-bottom: 18px;
        }

        .details-section-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 5px;
            letter-spacing: 0.5px;
        }

        .details-section-content {
            font-size: 13px;
            line-height: 1.5;
        }

        .details-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            word-break: break-all;
        }

        .details-link:hover {
            text-decoration: underline;
        }

        .stats-row {
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
            margin-bottom: 20px;
            padding: 14px 16px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }

        .stat-item {
            text-align: left;
        }

        .stat-item .stat-value {
            font-size: 18px;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }

        .stat-label {
            font-size: 10px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }

        .tag-container {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        .tag {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 12px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .tag.platform {
            background-color: var(--vscode-button-secondaryBackground);
        }

        .tag.deprecated {
            background-color: var(--vscode-errorForeground);
            color: white;
        }

        .tag.discontinued {
            background-color: #d32f2f;
            color: white;
        }

        .terminal-box {
            background-color: var(--vscode-terminal-background, #1e1e1e);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin-bottom: 12px;
            overflow: hidden;
        }

        .terminal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            background-color: var(--vscode-titleBar-activeBackground, #333);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-wrap: wrap;
            gap: 6px;
        }

        .terminal-title {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .terminal-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }

        .terminal-btn {
            padding: 3px 8px;
            font-size: 11px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .copy-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .copy-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .copy-btn.copied {
            background-color: #4CAF50;
            color: white;
        }

        .run-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .run-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .terminal-content {
            padding: 12px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            color: var(--vscode-terminal-foreground, #cccccc);
            overflow-x: auto;
            white-space: pre;
        }

        .terminal-prompt {
            color: var(--vscode-terminal-ansiGreen, #4EC9B0);
        }

        .version-comparison {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 14px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            margin-bottom: 15px;
        }

        .version-comparison.has-update {
            border-color: var(--vscode-editorWarning-foreground);
        }

        .version-box {
            text-align: center;
        }

        .version-box .label {
            font-size: 10px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }

        .version-box .value {
            font-size: 14px;
            font-weight: bold;
            font-family: monospace;
        }

        .version-box.current .value {
            color: var(--vscode-descriptionForeground);
        }

        .version-box.latest .value {
            color: var(--vscode-textLink-foreground);
        }

        .version-arrow-lg {
            font-size: 18px;
            color: var(--vscode-editorWarning-foreground);
        }
    </style>
</head>
<body>
    <!-- List Screen -->
    <div id="listScreen" class="list-screen">
        <div class="header">
            <div class="header-row">
                <div class="header-title">Installed Packages</div>
                <button class="refresh-btn" onclick="refresh()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
                    </svg>
                    Refresh
                </button>
            </div>
            <div id="statsBar" class="stats-bar" style="display: none;">
                <div class="stat">
                    <span class="stat-value" id="totalCount">0</span> packages
                </div>
                <div class="stat stat-outdated">
                    <span class="stat-value" id="outdatedCount">0</span> outdated
                </div>
                <div class="stat stat-discontinued">
                    <span class="stat-value" id="discontinuedCount">0</span> discontinued
                </div>
                <div class="stat stat-deprecated">
                    <span class="stat-value" id="deprecatedCount">0</span> deprecated
                </div>
            </div>
        </div>

        <div id="content">
            <div class="loading">
                <div class="spinner"></div>
                Loading installed packages...
            </div>
        </div>
    </div>

    <!-- Details Screen -->
    <div id="detailsScreen" class="details-screen">
        <div class="back-header">
            <button class="back-btn" onclick="goBack()">
                <span>&#8592;</span> Back
            </button>
        </div>
        <div id="detailsContent"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let packages = [];
        let currentPackageName = '';

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function updatePackage(packageName, version, event) {
            if (event) event.stopPropagation();
            vscode.postMessage({ command: 'updatePackage', packageName, version });
        }

        function removePackage(packageName, event) {
            if (event) event.stopPropagation();
            vscode.postMessage({ command: 'removePackage', packageName });
        }

        function showDetails(packageName) {
            currentPackageName = packageName;
            vscode.postMessage({ command: 'getDetails', packageName });
        }

        function viewOnPubDev(packageName) {
            vscode.postMessage({ command: 'viewOnPubDev', packageName });
        }

        function goBack() {
            currentPackageName = '';
            document.getElementById('listScreen').classList.remove('hidden');
            document.getElementById('detailsScreen').classList.remove('active');
        }

        function copyToClipboard(text, buttonId) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById(buttonId);
                const originalContent = btn.innerHTML;
                btn.innerHTML = '✓ Copied';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = originalContent;
                    btn.classList.remove('copied');
                }, 2000);
            });
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatNumber(num) {
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num?.toString() || '0';
        }

        function formatDate(dateStr) {
            if (!dateStr) return 'N/A';
            const date = new Date(dateStr);
            return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function renderPackages(pkgs) {
            packages = pkgs;
            const content = document.getElementById('content');
            const statsBar = document.getElementById('statsBar');

            if (!pkgs || pkgs.length === 0) {
                statsBar.style.display = 'none';
                content.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-icon">📦</div>
                        <div>No packages found in pubspec.yaml</div>
                    </div>
                \`;
                return;
            }

            // Update stats
            const total = pkgs.length;
            const outdated = pkgs.filter(p => p.isOutdated).length;
            const discontinued = pkgs.filter(p => p.isDiscontinued).length;
            const deprecated = pkgs.filter(p => p.isDeprecated).length;

            document.getElementById('totalCount').textContent = total;
            document.getElementById('outdatedCount').textContent = outdated;
            document.getElementById('discontinuedCount').textContent = discontinued;
            document.getElementById('deprecatedCount').textContent = deprecated;
            statsBar.style.display = 'flex';

            content.innerHTML = '<div class="package-list">' + pkgs.map(pkg => {
                const statusClass = pkg.isDeprecated || pkg.isDiscontinued ? 'deprecated' : (pkg.isOutdated ? 'outdated' : '');

                let statusIcon = '';
                if (pkg.isDiscontinued) {
                    statusIcon = '<span class="status-icon error"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Discontinued</span>';
                } else if (pkg.isDeprecated) {
                    statusIcon = '<span class="status-icon error"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Deprecated</span>';
                } else if (pkg.isOutdated) {
                    statusIcon = '<span class="status-icon warning"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-8h2v8z"/></svg> Update available</span>';
                }

                return \`
                    <div class="package-card \${statusClass}" onclick="showDetails('\${pkg.name}')">
                        <div class="package-header">
                            <div class="package-name-row">
                                <span class="package-name">\${pkg.name}</span>
                                \${statusIcon}
                            </div>
                            <div class="version-info">
                                <span class="current-version">\${pkg.currentVersion}</span>
                                \${pkg.latestVersion && pkg.isOutdated ? \`
                                    <span class="version-arrow">→</span>
                                    <span class="latest-version">\${pkg.latestVersion}</span>
                                \` : ''}
                            </div>
                        </div>
                        <div class="package-actions">
                            \${pkg.isOutdated && pkg.latestVersion ? \`
                                <button class="action-btn update-btn" onclick="updatePackage('\${pkg.name}', '\${pkg.latestVersion}', event)">
                                    Update to \${pkg.latestVersion}
                                </button>
                            \` : ''}
                            <button class="action-btn remove-btn" onclick="removePackage('\${pkg.name}', event)">
                                Remove
                            </button>
                            <button class="action-btn view-btn" onclick="event.stopPropagation(); viewOnPubDev('\${pkg.name}')">
                                pub.dev
                            </button>
                        </div>
                    </div>
                \`;
            }).join('') + '</div>';
        }

        function showDetailsScreen(details, score, currentVersion) {
            const listScreen = document.getElementById('listScreen');
            const detailsScreen = document.getElementById('detailsScreen');
            const detailsContent = document.getElementById('detailsContent');

            const pubspec = details.latest?.pubspec || {};
            const published = details.latest?.published;
            const latestVersion = details.latest?.version;
            const isDiscontinued = score?.tags?.includes('is:discontinued');
            const isDeprecated = score?.tags?.includes('is:deprecated') || isDiscontinued;
            const platforms = score?.tags?.filter(t => t.startsWith('platform:')).map(t => t.replace('platform:', '')) || [];

            const installedPkg = packages.find(p => p.name === details.name);
            const isOutdated = installedPkg?.isOutdated || false;

            detailsContent.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;">
                    <div class="details-title">\${details.name}</div>
                    \${isDiscontinued ? '<span class="tag discontinued">Discontinued</span>' : ''}
                    \${isDeprecated && !isDiscontinued ? '<span class="tag deprecated">Deprecated</span>' : ''}
                </div>

                <div class="version-comparison \${isOutdated ? 'has-update' : ''}">
                    <div class="version-box current">
                        <div class="label">Installed</div>
                        <div class="value">\${currentVersion || 'unknown'}</div>
                    </div>
                    \${isOutdated ? '<div class="version-arrow-lg">→</div>' : ''}
                    <div class="version-box latest">
                        <div class="label">Latest</div>
                        <div class="value">\${latestVersion || 'N/A'}</div>
                    </div>
                </div>

                <div class="details-content">
                    \${score ? \`
                    <div class="stats-row">
                        <div class="stat-item">
                            <div class="stat-value">\${formatNumber(score.likeCount)}</div>
                            <div class="stat-label">Likes</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${score.grantedPoints}/\${score.maxPoints}</div>
                            <div class="stat-label">Pub Points</div>
                        </div>
                        <div class="stat-item">
                            <div class="stat-value">\${formatNumber(score.downloadCount30Days)}</div>
                            <div class="stat-label">Monthly Downloads</div>
                        </div>
                    </div>
                    \` : ''}

                    <div class="details-section">
                        <div class="details-section-title">Description</div>
                        <div class="details-section-content">\${escapeHtml(pubspec.description || 'No description available')}</div>
                    </div>

                    <div class="details-section">
                        <div class="details-section-title">Published</div>
                        <div class="details-section-content">\${formatDate(published)}</div>
                    </div>

                    \${platforms.length > 0 ? \`
                    <div class="details-section">
                        <div class="details-section-title">Platforms</div>
                        <div class="tag-container">
                            \${platforms.map(p => \`<span class="tag platform">\${p}</span>\`).join('')}
                        </div>
                    </div>
                    \` : ''}

                    \${isOutdated && latestVersion ? \`
                    <div class="details-section">
                        <div class="details-section-title">Update Package</div>
                        <div class="terminal-box">
                            <div class="terminal-header">
                                <span class="terminal-title">Terminal</span>
                                <div class="terminal-actions">
                                    <button class="terminal-btn copy-btn" id="copyUpdateCmd" onclick="copyToClipboard('flutter pub add \${details.name}:\${latestVersion}', 'copyUpdateCmd')">
                                        Copy
                                    </button>
                                    <button class="terminal-btn run-btn" onclick="updatePackage('\${details.name}', '\${latestVersion}')">
                                        Run
                                    </button>
                                </div>
                            </div>
                            <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub add \${details.name}:\${latestVersion}</div>
                        </div>
                    </div>
                    \` : ''}

                    <div class="details-section">
                        <div class="details-section-title">Remove Package</div>
                        <div class="terminal-box">
                            <div class="terminal-header">
                                <span class="terminal-title">Terminal</span>
                                <div class="terminal-actions">
                                    <button class="terminal-btn copy-btn" id="copyRemoveCmd" onclick="copyToClipboard('flutter pub remove \${details.name}', 'copyRemoveCmd')">
                                        Copy
                                    </button>
                                    <button class="terminal-btn run-btn" onclick="removePackage('\${details.name}')">
                                        Run
                                    </button>
                                </div>
                            </div>
                            <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub remove \${details.name}</div>
                        </div>
                    </div>

                    \${pubspec.homepage ? \`
                    <div class="details-section">
                        <div class="details-section-title">Homepage</div>
                        <div class="details-section-content">
                            <a href="\${pubspec.homepage}" class="details-link">\${pubspec.homepage}</a>
                        </div>
                    </div>
                    \` : ''}

                    \${pubspec.repository ? \`
                    <div class="details-section">
                        <div class="details-section-title">Repository</div>
                        <div class="details-section-content">
                            <a href="\${pubspec.repository}" class="details-link">\${pubspec.repository}</a>
                        </div>
                    </div>
                    \` : ''}
                </div>
            \`;

            listScreen.classList.add('hidden');
            detailsScreen.classList.add('active');
            window.scrollTo(0, 0);
        }

        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.command) {
                case 'update':
                    if (message.loading) {
                        document.getElementById('statsBar').style.display = 'none';
                        document.getElementById('content').innerHTML = \`
                            <div class="loading">
                                <div class="spinner"></div>
                                Loading installed packages...
                            </div>
                        \`;
                    } else if (message.error) {
                        document.getElementById('statsBar').style.display = 'none';
                        document.getElementById('content').innerHTML = \`
                            <div class="error">\${message.error}</div>
                        \`;
                    } else if (message.empty) {
                        document.getElementById('statsBar').style.display = 'none';
                        document.getElementById('content').innerHTML = \`
                            <div class="empty-state">
                                <div class="empty-icon">📦</div>
                                <div>No packages found in pubspec.yaml</div>
                            </div>
                        \`;
                    } else if (message.packages) {
                        renderPackages(message.packages);
                    }
                    break;

                case 'packageDetails':
                    showDetailsScreen(message.details, message.score, message.currentVersion);
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
