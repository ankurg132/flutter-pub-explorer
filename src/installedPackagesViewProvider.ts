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
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/pubspec.{yaml,lock}');

        const refreshDebounced = this.debounce(() => {
            if (this._view?.visible) {
                this.loadInstalledPackages();
            } else {
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

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

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

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            if (!trimmedLine || trimmedLine.startsWith('#')) {
                continue;
            }

            if (line.match(/^dependencies:\s*$/)) {
                inDependencies = true;
                inDevDependencies = false;
                continue;
            }

            if (line.match(/^dev_dependencies:\s*$/)) {
                inDependencies = false;
                inDevDependencies = true;
                continue;
            }

            if (!line.startsWith(' ') && !line.startsWith('\t') && trimmedLine.endsWith(':')) {
                inDependencies = false;
                inDevDependencies = false;
                continue;
            }

            if (inDependencies || inDevDependencies) {
                const simpleMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*[\^~]?(\d+\.\d+\.\d+[^\s]*)\s*$/i);
                if (simpleMatch) {
                    dependencies.push({
                        name: simpleMatch[1],
                        version: simpleMatch[2]
                    });
                    continue;
                }

                const caretMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*["']?[\^~]?(\d+\.\d+\.\d+[^"'\s]*)["']?\s*$/i);
                if (caretMatch) {
                    dependencies.push({
                        name: caretMatch[1],
                        version: caretMatch[2]
                    });
                    continue;
                }

                const anyMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*any\s*$/i);
                if (anyMatch) {
                    dependencies.push({
                        name: anyMatch[1],
                        version: 'any'
                    });
                    continue;
                }

                const packageNameOnlyMatch = trimmedLine.match(/^([a-z_][a-z0-9_]*)\s*:\s*$/i);
                if (packageNameOnlyMatch) {
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

        const current = currentVersion.replace(/[\^~>=<\s"']/g, '').split('.').map(Number);
        const latest = latestVersion.replace(/[\^~>=<\s"']/g, '').split('.').map(Number);

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

    private getHtmlContent(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'installed');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'styles.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'script.js'));

        const htmlPath = vscode.Uri.joinPath(mediaPath, 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

        html = html.replace('{{stylesUri}}', stylesUri.toString());
        html = html.replace('{{scriptUri}}', scriptUri.toString());

        return html;
    }
}
