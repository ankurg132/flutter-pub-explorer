import * as vscode from 'vscode';
import * as fs from 'fs';
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

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

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
                case 'loadFilter':
                    await this.loadFilteredPackages(message.filter, message.page || 1);
                    break;
                case 'loadFilterMore':
                    await this.loadMorePackages(message.filter, message.page);
                    break;
                case 'searchMore':
                    await this.searchMorePackages(message.query, message.page);
                    break;
            }
        });

        // Restore cached data when view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this.packages.length > 0) {
                this.updateView({ packages: this.packages, query: this.currentQuery });
            }
        });

        this.loadFilteredPackages('popular');
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
        await this.loadFilteredPackages('popular');
    }

    private async loadFilteredPackages(filter: string, page: number = 1): Promise<void> {
        if (this.isLoading) {
            return;
        }

        this.isLoading = true;
        this.updateView({ loading: true });

        try {
            const result = await this.getFilteredResult(filter, page);

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
            this.updateView({ packages: this.packages, query: '', hasMore: !!result.next });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load packages: ${error}`);
            this.updateView({ error: 'Failed to load packages' });
        } finally {
            this.isLoading = false;
        }
    }

    private async getFilteredResult(filter: string, page: number = 1) {
        switch (filter) {
            case 'popular':
                return await this.api.getPopularPackages(page);
            case 'favorites':
                return await this.api.getFlutterFavorites(page);
            case 'trending':
                return await this.api.getTrendingPackages(page);
            case 'top-rated':
                return await this.api.getTopRatedPackages(page);
            case 'new':
                return await this.api.getNewPackages(page);
            case 'updated':
                return await this.api.getRecentlyUpdated(page);
            case 'android':
            case 'ios':
            case 'web':
            case 'windows':
            case 'macos':
            case 'linux':
                return await this.api.getPlatformPackages(filter, page);
            case 'ui':
            case 'state':
            case 'networking':
            case 'storage':
            case 'firebase':
            case 'utils':
                return await this.api.getCategoryPackages(filter, page);
            default:
                return await this.api.getPopularPackages(page);
        }
    }

    private async loadMorePackages(filter: string, page: number): Promise<void> {
        try {
            const result = await this.getFilteredResult(filter, page);
            const newPackages = result.packages.map(p => ({ package: p.package }));

            const detailsPromises = newPackages.slice(0, 10).map(async (pkg) => {
                try {
                    const details = await this.api.getPackageDetails(pkg.package);
                    return { package: pkg.package, details };
                } catch {
                    return { package: pkg.package };
                }
            });

            const packagesWithDetails = await Promise.all(detailsPromises);
            this._view?.webview.postMessage({
                command: 'packagesMore',
                packages: packagesWithDetails,
                hasMore: !!result.next
            });
        } catch (error) {
            this._view?.webview.postMessage({
                command: 'packagesMore',
                packages: [],
                hasMore: false
            });
        }
    }

    private async searchMorePackages(query: string, page: number): Promise<void> {
        try {
            const result = await this.api.searchPackages(query, page);
            const newPackages = result.packages.map(p => ({ package: p.package }));

            const detailsPromises = newPackages.slice(0, 10).map(async (pkg) => {
                try {
                    const details = await this.api.getPackageDetails(pkg.package);
                    return { package: pkg.package, details };
                } catch {
                    return { package: pkg.package };
                }
            });

            const packagesWithDetails = await Promise.all(detailsPromises);
            this._view?.webview.postMessage({
                command: 'packagesMore',
                packages: packagesWithDetails,
                hasMore: !!result.next
            });
        } catch (error) {
            this._view?.webview.postMessage({
                command: 'packagesMore',
                packages: [],
                hasMore: false
            });
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

    private updateView(data: { packages?: Array<{ package: string; details?: PackageDetails }>; query?: string; loading?: boolean; error?: string; hasMore?: boolean }): void {
        this._view?.webview.postMessage({
            command: 'update',
            ...data
        });
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'packages');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'styles.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'script.js'));

        const htmlPath = vscode.Uri.joinPath(mediaPath, 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf-8');

        html = html.replace('{{stylesUri}}', stylesUri.toString());
        html = html.replace('{{scriptUri}}', scriptUri.toString());

        return html;
    }
}
