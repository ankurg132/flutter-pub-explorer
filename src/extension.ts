import * as vscode from 'vscode';
import { PackagesViewProvider } from './packagesViewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Flutter Pub Explorer is now active');

    const packagesViewProvider = new PackagesViewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            PackagesViewProvider.viewType,
            packagesViewProvider
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
