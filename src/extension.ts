import * as vscode from 'vscode';

interface ForcePushConfig {
	updateInterval: number;
	showNotifications: boolean;
	alignment: 'top' | 'center' | 'bottom';
}

const DEFAULT_CONFIG: ForcePushConfig = {
	updateInterval: 1000,
	showNotifications: true,
	alignment: 'top'
};

function getConfig(): ForcePushConfig {
	const config = vscode.workspace.getConfiguration('forcePushButton');
	return {
		updateInterval: config.get('updateInterval') ?? DEFAULT_CONFIG.updateInterval,
		showNotifications: config.get('showNotifications') ?? DEFAULT_CONFIG.showNotifications,
		alignment: config.get('alignment') ?? DEFAULT_CONFIG.alignment
	};
}

function getForcePushHtml(disabled: boolean) {
	const config = getConfig();
	const alignmentClass = `align-${config.alignment}`;

	return `
		<style>
			body {
				padding: 0;
				margin: 0;
				background: transparent;
				display: flex;
				flex-direction: column;
				min-height: 100vh;
			}
			.align-top {
				margin-top: 0;
			}
			.align-center {
				margin-top: auto;
				margin-bottom: auto;
			}
			.align-bottom {
				margin-top: auto;
			}
			.force-push-btn {
				display: flex;
				align-items: center;
				justify-content: center;
				background: var(--vscode-button-background);
				color: var(--vscode-button-foreground);
				border: none;
				border-radius: 4px;
				height: 28px;
				font-size: var(--vscode-font-size);
				font-family: var(--vscode-font-family);
				cursor: pointer;
				width: calc(100% - 30px);
				margin-left: 18px;
				margin-right: 12px;
				transition: all 0.2s;
				box-sizing: border-box;
				outline: none;
				user-select: none;
				opacity: ${disabled ? '0.5' : '1'};
				pointer-events: ${disabled ? 'none' : 'auto'};
			}
			.force-push-btn:hover {
				background: var(--vscode-button-hoverBackground);
			}
			.force-push-btn:active {
				background: var(--vscode-button-background);
			}
			.force-push-icon {
				margin-right: 8px;
				font-size: 18px;
				line-height: 1;
				display: flex;
				align-items: center;
			}
		</style>
		<div class="${alignmentClass}">
			<button class="force-push-btn" id="forcePushBtn" onclick="vscode.postMessage({ command: 'forcePush' })" ${disabled ? 'disabled' : ''}>
				<span class="force-push-icon">&#8593;</span> Force Push
			</button>
		</div>
		<script>
			const vscode = acquireVsCodeApi();
			window.addEventListener('message', event => {
				const { command, enabled } = event.data;
				if (command === 'setEnabled') {
					const btn = document.getElementById('forcePushBtn');
					if (btn) {
						btn.disabled = !enabled;
						btn.style.opacity = enabled ? '1' : '0.5';
						btn.style.pointerEvents = enabled ? 'auto' : 'none';
					}
				}
			});
		</script>
	`;
}

export function activate(context: vscode.ExtensionContext) {
	// Check if this is first installation and set allowForcePush
	const hasInitialized = context.globalState.get('hasInitializedForcePush');
	if (!hasInitialized) {
		vscode.workspace.getConfiguration('git').update('allowForcePush', true, true);
		context.globalState.update('hasInitializedForcePush', true);
	}

	let webviewPanel: vscode.WebviewView | undefined;
	let statusBarItem: vscode.StatusBarItem;
	let isPushing = false;
	let updateInterval: NodeJS.Timeout;

	// Create status bar item to track Git state
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	context.subscriptions.push(statusBarItem);

	// Add the button to the source control view as a webview
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('force-push-button', {
			resolveWebviewView(webviewView) {
				webviewPanel = webviewView;
				webviewView.webview.options = {
					enableScripts: true,
					localResourceRoots: []
				};
				webviewView.webview.html = getForcePushHtml(true); // Start as disabled

				webviewView.webview.onDidReceiveMessage(async (message) => {
					if (message.command === 'forcePush') {
						await handleForcePush();
					}
				});
				updateButtonState();
			}
		}, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		})
	);

	// Listen to configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('forcePushButton')) {
				updateWebviewHtml();
			}
		})
	);

	// Listen to Git changes and update button
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			updateButtonState();
		})
	);

	// Update button state periodically
	const config = getConfig();
	updateInterval = setInterval(updateButtonState, config.updateInterval);
	context.subscriptions.push({ dispose: () => clearInterval(updateInterval) });

	updateButtonState();

	function updateWebviewHtml() {
		if (webviewPanel) {
			const isEnabled = webviewPanel.webview.html.includes('opacity: 1');
			webviewPanel.webview.html = getForcePushHtml(!isEnabled);
		}
	}

	async function handleForcePush(): Promise<void> {
		if (isPushing) return;

		isPushing = true;
		setButtonEnabled(false);

		try {
			await vscode.commands.executeCommand('git.pushForce');
			if (getConfig().showNotifications) {
				vscode.window.showInformationMessage('Force push completed successfully');
			}
		} catch (error) {
			console.error('[ForcePush] Error during force push:', error);
			if (getConfig().showNotifications) {
				vscode.window.showErrorMessage(
					'Failed to force push. Please check the output panel for details.'
				);
			}
		} finally {
			isPushing = false;
			updateButtonState();
		}
	}

	async function updateButtonState(): Promise<void> {
		try {
			// If we're currently pushing, keep the button disabled
			if (isPushing) {
				setButtonEnabled(false);
				return;
			}

			const gitExtension = vscode.extensions.getExtension('vscode.git');
			if (!gitExtension) {
				setButtonEnabled(false);
				return;
			}

			const git = gitExtension.exports;
			const api = git.getAPI(1);

			const repos = api.repositories;
			if (!repos || repos.length === 0) {
				setButtonEnabled(false);
				return;
			}

			const hasIncomingChanges = repos.some((repo: { state: { HEAD?: { behind?: number; upstream?: string } } }) => {
				const state = repo.state;
				const head = state.HEAD;
				const behind = head?.behind ?? 0;
				const hasUpstream = !!head?.upstream;
				return hasUpstream && behind > 0;
			});

			setButtonEnabled(hasIncomingChanges);
		} catch (error) {
			console.error('[ForcePush] Error updating button state:', error);
			setButtonEnabled(false);
		}
	}

	function setButtonEnabled(enabled: boolean): void {
		if (webviewPanel) {
			webviewPanel.webview.postMessage({ command: 'setEnabled', enabled });
		}
	}
}

export function deactivate() {
	// Clean up any resources if needed
}
