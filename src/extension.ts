import * as vscode from 'vscode';
import { PackagesViewProvider } from './packagesViewProvider';
import { InstalledPackagesViewProvider } from './installedPackagesViewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Flutter Pub Explorer is now active');

    const packagesViewProvider = new PackagesViewProvider(context.extensionUri);
    const installedPackagesViewProvider = new InstalledPackagesViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PackagesViewProvider.viewType,
            packagesViewProvider
        ),
        vscode.window.registerWebviewViewProvider(
            InstalledPackagesViewProvider.viewType,
            installedPackagesViewProvider
        )
    );

    const openExplorerCommand = vscode.commands.registerCommand(
        'flutterPubExplorer.openExplorer',
        () => {
            vscode.commands.executeCommand('flutterPubExplorer.packagesView.focus');
        }
    );

    context.subscriptions.push(openExplorerCommand);
}

export function deactivate() {
    console.log('Flutter Pub Explorer has been deactivated');
}
