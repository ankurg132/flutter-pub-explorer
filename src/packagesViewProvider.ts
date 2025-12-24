import * as vscode from 'vscode';
import { PubDevApi, PackageDetails, PackageScore } from './pubDevApi';

export class PackagesViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'flutterPubExplorer.packagesView';

    private _view?: vscode.WebviewView;
    private readonly api: PubDevApi;
    private packages: Array<{ package: string; details?: PackageDetails }> = [];
    private currentQuery: string = '';
    private isLoading: boolean = false;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.api = new PubDevApi();
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
                case 'search':
                    await this.searchPackages(message.query);
                    break;
                case 'addPackage':
                    await this.addPackage(message.packageName, message.version);
                    break;
                case 'loadPopular':
                    await this.loadPopularPackages();
                    break;
                case 'getDetails':
                    await this.getPackageDetails(message.packageName);
                    break;
                case 'viewOnPubDev':
                    vscode.env.openExternal(vscode.Uri.parse(`https://pub.dev/packages/${message.packageName}`));
                    break;
            }
        });

        this.loadPopularPackages();
    }

    private async searchPackages(query: string): Promise<void> {
        if (this.isLoading || !query.trim()) {
            return;
        }

        this.isLoading = true;
        this.currentQuery = query;
        this.updateView({ loading: true });

        try {
            const result = await this.api.searchPackages(query);
            this.packages = result.packages.map(p => ({ package: p.package }));

            const detailsPromises = this.packages.slice(0, 10).map(async (pkg) => {
                try {
                    const details = await this.api.getPackageDetails(pkg.package);
                    return { package: pkg.package, details };
                } catch {
                    return { package: pkg.package };
                }
            });

            this.packages = await Promise.all(detailsPromises);
            this.updateView({ packages: this.packages, query: this.currentQuery });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to search packages: ${error}`);
            this.updateView({ error: 'Failed to search packages' });
        } finally {
            this.isLoading = false;
        }
    }

    private async loadPopularPackages(): Promise<void> {
        if (this.isLoading) {
            return;
        }

        this.isLoading = true;
        this.updateView({ loading: true });

        try {
            const result = await this.api.getFlutterPackages();
            this.packages = result.packages.map(p => ({ package: p.package }));

            const detailsPromises = this.packages.slice(0, 10).map(async (pkg) => {
                try {
                    const details = await this.api.getPackageDetails(pkg.package);
                    return { package: pkg.package, details };
                } catch {
                    return { package: pkg.package };
                }
            });

            this.packages = await Promise.all(detailsPromises);
            this.updateView({ packages: this.packages, query: '' });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load packages: ${error}`);
            this.updateView({ error: 'Failed to load packages' });
        } finally {
            this.isLoading = false;
        }
    }

    private async getPackageDetails(packageName: string): Promise<void> {
        try {
            const [details, score] = await Promise.all([
                this.api.getPackageDetails(packageName),
                this.api.getPackageScore(packageName).catch(() => null)
            ]);
            this._view?.webview.postMessage({
                command: 'packageDetails',
                details,
                score
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to get package details: ${error}`);
        }
    }

    private async addPackage(packageName: string, version?: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open. Please open a Flutter project first.');
            return;
        }

        let workspaceFolder = workspaceFolders[0];

        if (workspaceFolders.length > 1) {
            const selected = await vscode.window.showQuickPick(
                workspaceFolders.map(f => ({ label: f.name, folder: f })),
                { placeHolder: 'Select the Flutter project to add the package to' }
            );
            if (!selected) {
                return;
            }
            workspaceFolder = selected.folder;
        }

        const command = this.api.getFlutterPubAddCommand(packageName, version);

        const terminal = vscode.window.createTerminal({
            name: 'Flutter Pub Add',
            cwd: workspaceFolder.uri.fsPath
        });

        terminal.show();
        terminal.sendText(command);

        vscode.window.showInformationMessage(`Running: ${command}`);
    }

    private updateView(data: { packages?: Array<{ package: string; details?: PackageDetails }>; query?: string; loading?: boolean; error?: string }): void {
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
    <title>Pub Explorer</title>
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

        .search-container {
            position: sticky;
            top: 0;
            background-color: var(--vscode-sideBar-background);
            padding-bottom: 10px;
            z-index: 100;
        }

        .search-box {
            display: flex;
            gap: 5px;
        }

        #searchInput {
            flex: 1;
            padding: 6px 10px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            outline: none;
        }

        #searchInput:focus {
            border-color: var(--vscode-focusBorder);
        }

        .search-btn {
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }

        .search-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .package-list {
            margin-top: 10px;
        }

        .package-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 10px;
            cursor: pointer;
            transition: border-color 0.2s, background-color 0.2s;
        }

        .package-card:hover {
            border-color: var(--vscode-focusBorder);
            background-color: var(--vscode-list-hoverBackground);
        }

        .package-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 8px;
        }

        .package-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            font-size: 14px;
        }

        .package-version {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            padding: 2px 6px;
            border-radius: 3px;
        }

        .package-description {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 10px;
            line-height: 1.4;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .package-actions {
            display: flex;
            gap: 8px;
        }

        .add-btn {
            padding: 4px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .add-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .details-btn {
            padding: 4px 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .details-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .loading {
            text-align: center;
            padding: 20px;
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
            padding: 20px;
        }

        .header-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }

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

        .details-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 20px;
            padding-top: 15px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .details-action-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
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

        .stat-value {
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

        .tag.flutter-favorite {
            background-color: #0175C2;
            color: white;
        }

        .tag.null-safe {
            background-color: #4CAF50;
            color: white;
        }

        .dependency-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .dependency-item {
            font-size: 12px;
            font-family: monospace;
            padding: 4px 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 4px;
        }

        .dependency-item.clickable {
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .dependency-item.clickable:hover {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-textLink-foreground);
        }

        .sdk-constraint {
            font-family: monospace;
            font-size: 12px;
            color: var(--vscode-textPreformat-foreground);
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

        .icon-btn {
            padding: 4px 6px;
            background-color: transparent;
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background-color 0.2s, border-color 0.2s;
        }

        .icon-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .icon-btn.copied {
            background-color: #4CAF50;
            border-color: #4CAF50;
            color: white;
        }

        .add-app-btn {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
            transition: background-color 0.2s;
        }

        .add-app-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
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

        .version-select {
            padding: 4px 8px;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            font-size: 12px;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <!-- List Screen -->
    <div id="listScreen" class="list-screen">
        <div class="search-container">
            <div class="search-box">
                <input type="text" id="searchInput" placeholder="Search packages..." />
                <button class="search-btn" onclick="search()">Search</button>
            </div>
        </div>

        <div class="header-title" id="resultsHeader">Flutter Packages</div>

        <div id="content">
            <div class="loading">
                <div class="spinner"></div>
                Loading packages...
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

        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                search();
            }
        });

        function search() {
            const query = document.getElementById('searchInput').value.trim();
            if (query) {
                vscode.postMessage({ command: 'search', query });
            }
        }

        function addPackage(packageName, version) {
            vscode.postMessage({ command: 'addPackage', packageName, version });
        }

        function showDetails(packageName) {
            if (!isNavigatingBack && currentPackageName && currentPackageName !== packageName) {
                navigationStack.push(currentPackageName);
            }
            isNavigatingBack = false;
            vscode.postMessage({ command: 'getDetails', packageName });
        }

        function viewOnPubDev(packageName) {
            vscode.postMessage({ command: 'viewOnPubDev', packageName });
        }

        function copyToClipboard(text, buttonId) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = document.getElementById(buttonId);
                const originalContent = btn.innerHTML;
                const isIconBtn = btn.classList.contains('icon-btn');

                if (isIconBtn) {
                    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                } else {
                    btn.innerHTML = '✓ Copied';
                }
                btn.classList.add('copied');

                setTimeout(() => {
                    btn.innerHTML = originalContent;
                    btn.classList.remove('copied');
                }, 2000);
            });
        }

        let currentPackageName = '';
        let navigationStack = [];
        let isNavigatingBack = false;

        function updateVersionCommand() {
            const select = document.getElementById('versionSelect');
            const content = document.getElementById('versionCmdContent');
            if (select && content && currentPackageName) {
                content.innerHTML = '<span class="terminal-prompt">$</span> flutter pub add ' + currentPackageName + ':' + select.value;
            }
        }

        function goBack() {
            if (navigationStack.length > 0) {
                const previousPackage = navigationStack.pop();
                isNavigatingBack = true;
                vscode.postMessage({ command: 'getDetails', packageName: previousPackage });
            } else {
                currentPackageName = '';
                document.getElementById('listScreen').classList.remove('hidden');
                document.getElementById('detailsScreen').classList.remove('active');
            }
        }

        function showDetailsScreen(details, score) {
            const listScreen = document.getElementById('listScreen');
            const detailsScreen = document.getElementById('detailsScreen');
            const detailsContent = document.getElementById('detailsContent');

            const versions = details.versions?.slice().reverse().slice(0, 10) || [];
            const pubspec = details.latest?.pubspec || {};
            const environment = pubspec.environment || {};
            const dependencies = pubspec.dependencies || {};
            const published = details.latest?.published;

            // Format numbers
            const formatNumber = (num) => {
                if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
                if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
                return num?.toString() || '0';
            };

            // Format date
            const formatDate = (dateStr) => {
                if (!dateStr) return 'N/A';
                const date = new Date(dateStr);
                return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
            };

            // Extract platforms from tags
            const platforms = score?.tags?.filter(t => t.startsWith('platform:')).map(t => t.replace('platform:', '')) || [];
            const isFlutterFavorite = score?.tags?.includes('is:flutter-favorite');
            const isNullSafe = score?.tags?.includes('is:null-safe');
            const license = score?.tags?.find(t => t.startsWith('license:'))?.replace('license:', '').toUpperCase();

            // Get dependencies (exclude flutter sdk)
            const depList = Object.entries(dependencies)
                .filter(([name, value]) => typeof value === 'string')
                .slice(0, 8);

            detailsContent.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                    <div class="details-title">\${details.name}</div>
                    <button class="add-app-btn" onclick="addPackage('\${details.name}')" title="Run flutter pub add \${details.name}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        Add to Application
                    </button>
                </div>
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                    <span class="package-version">v\${details.latest?.version || 'N/A'}</span>
                    \${isFlutterFavorite ? '<span class="tag flutter-favorite">Flutter Favorite</span>' : ''}
                    \${isNullSafe ? '<span class="tag null-safe">Null Safe</span>' : ''}
                    <button class="details-btn" onclick="viewOnPubDev('\${details.name}')">
                        View on pub.dev
                    </button>
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

                    \${environment.sdk || environment.flutter ? \`
                    <div class="details-section">
                        <div class="details-section-title">SDK Constraints</div>
                        <div class="details-section-content">
                            \${environment.sdk ? \`<div class="sdk-constraint">Dart: \${environment.sdk}</div>\` : ''}
                            \${environment.flutter ? \`<div class="sdk-constraint">Flutter: \${environment.flutter}</div>\` : ''}
                        </div>
                    </div>
                    \` : ''}

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

                    <div class="details-section">
                        <div class="details-section-title">Add to pubspec.yaml</div>
                        <div class="terminal-box">
                            <div class="terminal-header">
                                <span class="terminal-title">pubspec.yaml</span>
                                <div class="terminal-actions">
                                    <button class="terminal-btn copy-btn" id="copyDep" onclick="copyToClipboard('\${details.name}: ^\${details.latest?.version || ''}', 'copyDep')">
                                        Copy
                                    </button>
                                </div>
                            </div>
                            <div class="terminal-content">dependencies:\n  \${details.name}: ^\${details.latest?.version || ''}</div>
                        </div>
                    </div>

                    <div class="details-section">
                        <div class="details-section-title">Install via Terminal</div>
                        <div class="terminal-box">
                            <div class="terminal-header">
                                <span class="terminal-title">Terminal</span>
                                <div class="terminal-actions">
                                    <button class="terminal-btn copy-btn" id="copyCmd" onclick="copyToClipboard('flutter pub add \${details.name}', 'copyCmd')">
                                        Copy
                                    </button>
                                    <button class="terminal-btn run-btn" onclick="addPackage('\${details.name}')">
                                        Run
                                    </button>
                                </div>
                            </div>
                            <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub add \${details.name}</div>
                        </div>
                    </div>

                    <div class="details-section">
                        <div class="details-section-title">Install Specific Version</div>
                        <div class="terminal-box">
                            <div class="terminal-header">
                                <span class="terminal-title">Terminal</span>
                                <div class="terminal-actions">
                                    <select class="version-select" id="versionSelect" onchange="updateVersionCommand()">
                                        \${versions.map(v => \`<option value="\${v.version}">\${v.version}</option>\`).join('')}
                                    </select>
                                    <button class="terminal-btn copy-btn" id="copyVerCmd" onclick="copyToClipboard('flutter pub add \${details.name}:' + document.getElementById('versionSelect').value, 'copyVerCmd')">
                                        Copy
                                    </button>
                                    <button class="terminal-btn run-btn" onclick="addPackage('\${details.name}', document.getElementById('versionSelect').value)">
                                        Run
                                    </button>
                                </div>
                            </div>
                            <div class="terminal-content" id="versionCmdContent"><span class="terminal-prompt">$</span> flutter pub add \${details.name}:\${versions[0]?.version || details.latest?.version}</div>
                        </div>
                    </div>

                    \${depList.length > 0 ? \`
                    <div class="details-section" style="margin-top: 24px;">
                        <div class="details-section-title">Dependencies (\${Object.keys(dependencies).length})</div>
                        <div class="dependency-list">
                            \${depList.map(([name, version]) => \`<div class="dependency-item clickable" onclick="showDetails('\${name}')">\${name}: \${version}</div>\`).join('')}
                            \${Object.keys(dependencies).length > 8 ? \`<div class="dependency-item" style="color: var(--vscode-descriptionForeground);">... and \${Object.keys(dependencies).length - 8} more</div>\` : ''}
                        </div>
                    </div>
                    \` : ''}

                    \${license ? \`
                    <div class="details-section">
                        <div class="details-section-title">License</div>
                        <div class="details-section-content">\${license}</div>
                    </div>
                    \` : ''}
                </div>
            \`;

            currentPackageName = details.name;
            isNavigatingBack = false;
            listScreen.classList.add('hidden');
            detailsScreen.classList.add('active');
            window.scrollTo(0, 0);
        }

        window.addEventListener('message', (event) => {
            const message = event.data;

            switch (message.command) {
                case 'update':
                    if (message.loading) {
                        document.getElementById('content').innerHTML = \`
                            <div class="loading">
                                <div class="spinner"></div>
                                Loading packages...
                            </div>
                        \`;
                    } else if (message.error) {
                        document.getElementById('content').innerHTML = \`
                            <div class="error">\${message.error}</div>
                        \`;
                    } else if (message.packages) {
                        packages = message.packages;
                        const header = message.query
                            ? \`Search results for "\${message.query}"\`
                            : 'Flutter Packages';
                        document.getElementById('resultsHeader').textContent = header;
                        renderPackages(packages);
                    }
                    break;

                case 'packageDetails':
                    showDetailsScreen(message.details, message.score);
                    break;
            }
        });

        function renderPackages(packages) {
            const content = document.getElementById('content');

            if (!packages || packages.length === 0) {
                content.innerHTML = '<div class="loading">No packages found</div>';
                return;
            }

            content.innerHTML = packages.map(pkg => {
                const details = pkg.details;
                const name = pkg.package;
                const version = details?.latest?.version || '';
                const description = details?.latest?.pubspec?.description || 'No description available';

                return \`
                    <div class="package-card" onclick="showDetails('\${name}')">
                        <div class="package-header">
                            <span class="package-name">\${name}</span>
                            \${version ? \`<span class="package-version">v\${version}</span>\` : ''}
                        </div>
                        <div class="package-description">\${escapeHtml(description)}</div>
                        <div class="package-actions">
                            <button class="add-btn" onclick="event.stopPropagation(); addPackage('\${name}')">
                                flutter pub add
                            </button>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
