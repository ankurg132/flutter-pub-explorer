import * as vscode from 'vscode';
import { PubDevApi, PackageDetails } from './pubDevApi';

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
            const details = await this.api.getPackageDetails(packageName);
            this._view?.webview.postMessage({
                command: 'packageDetails',
                details
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

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            justify-content: center;
            align-items: center;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 20px;
            max-width: 90%;
            max-height: 80%;
            overflow-y: auto;
        }

        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }

        .modal-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            font-size: 20px;
            cursor: pointer;
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

    <div class="modal" id="detailsModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="modalTitle">Package Details</h3>
                <button class="modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div id="modalBody"></div>
        </div>
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
            vscode.postMessage({ command: 'getDetails', packageName });
        }

        function closeModal() {
            document.getElementById('detailsModal').classList.remove('active');
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
                    showDetailsModal(message.details);
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
                    <div class="package-card">
                        <div class="package-header">
                            <span class="package-name">\${name}</span>
                            \${version ? \`<span class="package-version">v\${version}</span>\` : ''}
                        </div>
                        <div class="package-description">\${escapeHtml(description)}</div>
                        <div class="package-actions">
                            <button class="add-btn" onclick="addPackage('\${name}')">
                                flutter pub add
                            </button>
                            <button class="details-btn" onclick="showDetails('\${name}')">
                                Details
                            </button>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function showDetailsModal(details) {
            const modal = document.getElementById('detailsModal');
            const title = document.getElementById('modalTitle');
            const body = document.getElementById('modalBody');

            title.textContent = details.name;

            const versions = details.versions?.slice(0, 10) || [];
            const pubspec = details.latest?.pubspec || {};

            body.innerHTML = \`
                <p><strong>Latest Version:</strong> \${details.latest?.version || 'N/A'}</p>
                <p style="margin: 10px 0;"><strong>Description:</strong><br/>\${escapeHtml(pubspec.description || 'No description')}</p>
                \${pubspec.homepage ? \`<p><strong>Homepage:</strong> <a href="\${pubspec.homepage}" style="color: var(--vscode-textLink-foreground);">\${pubspec.homepage}</a></p>\` : ''}
                \${pubspec.repository ? \`<p><strong>Repository:</strong> <a href="\${pubspec.repository}" style="color: var(--vscode-textLink-foreground);">\${pubspec.repository}</a></p>\` : ''}

                <div style="margin-top: 15px;">
                    <strong>Add specific version:</strong><br/>
                    <select class="version-select" id="versionSelect">
                        \${versions.map(v => \`<option value="\${v.version}">\${v.version}</option>\`).join('')}
                    </select>
                    <button class="add-btn" onclick="addPackage('\${details.name}', document.getElementById('versionSelect').value)">
                        flutter pub add
                    </button>
                </div>

                <p style="margin-top: 15px; font-size: 11px; color: var(--vscode-descriptionForeground);">
                    Command: flutter pub add \${details.name}
                </p>
            \`;

            modal.classList.add('active');
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Close modal when clicking outside
        document.getElementById('detailsModal').addEventListener('click', (e) => {
            if (e.target.id === 'detailsModal') {
                closeModal();
            }
        });
    </script>
</body>
</html>`;
    }
}
