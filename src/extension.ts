import * as vscode from 'vscode';
import { execFile } from 'child_process';

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

function getGitApi(): any {
	const gitExtension = vscode.extensions.getExtension('vscode.git');
	return gitExtension?.exports?.getAPI(1);
}

function resolveRepositoryFromContext(scmContext: unknown, api: any): any {
	const sourceControl: any = (scmContext as any)?.sourceControl ?? scmContext;
	if (!sourceControl) { return undefined as any; }
	return api.repositories.find((r: any) => r.sourceControl === sourceControl)
		|| (sourceControl?.rootUri
			? api.repositories.find((r: any) => r.rootUri?.toString() === sourceControl.rootUri.toString())
			: undefined);
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

async function execGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		execFile('git', args, { cwd }, (error, stdout, stderr) => {
			if (error) { const err = error as Error & { stderr?: string }; err.stderr = stderr; reject(err); return; }
			resolve({ stdout, stderr });
		});
	});
}

function getGitSettings() {
	const cfg = vscode.workspace.getConfiguration('git');
	return {
		allowForcePush: cfg.get<boolean>('allowForcePush', false),
		withLease: cfg.get<boolean>('useForcePushWithLease', false) === true,
		ifIncludes: cfg.get<boolean>('useForcePushIfIncludes', false) === true
	};
}

function buildForceArgs(remote: string, branch: string, withLease: boolean, ifIncludes: boolean): string[] {
	const args = ['push'];
	args.push(withLease ? '--force-with-lease' : '--force');
	if (withLease && ifIncludes) { args.push('--force-if-includes'); }
	args.push(remote, branch);
	return args;
}

function showPushErrorPopup(error: unknown, fallback: string) {
	const err: any = error as any;
	const details = typeof err === 'string' ? err : (err?.stderr || err?.message || '');
	const message = details ? `Failed to force push: ${details}` : fallback;
	vscode.window.showErrorMessage(message);
}

async function forcePushRepo(repo: any): Promise<void> {
	const settings = getGitSettings();
	if (!settings.allowForcePush) {
		vscode.window.showErrorMessage('Force push is disabled. Enable Git: Allow Force Push to continue.');
		return;
	}
	const head = repo.state?.HEAD;
	const remote = head?.upstream?.remote ?? 'origin';
	const branch = head?.name;
	if (!branch) {
		vscode.window.showErrorMessage('Unable to determine current branch for force push.');
		return;
	}
	const args = buildForceArgs(remote, branch, settings.withLease, settings.ifIncludes);
	const cwd = repo.rootUri?.fsPath ?? '.';
	await execGit(cwd, args);
	try { await repo.status?.(); } catch { }
}

export function activate(context: vscode.ExtensionContext) {
	// Check if this is first installation and set allowForcePush
	const hasInitialized = context.globalState.get('hasInitializedForcePush');
	if (!hasInitialized) {
		vscode.workspace.getConfiguration('git').update('allowForcePush', true, true);
		context.globalState.update('hasInitializedForcePush', true);
	}

	let webviewPanel: vscode.WebviewView | undefined;
	let isPushing = false;
	let updateInterval: NodeJS.Timeout;

	context.subscriptions.push(
		vscode.commands.registerCommand('force-push-button.forcePushRepo', async (scmContext?: unknown) => {
			if (isPushing) { return; }
			const api = getGitApi();
			if (!api) { return; }
			const repo = resolveRepositoryFromContext(scmContext, api);
			if (!repo) { return; }

			isPushing = true;
			setButtonEnabled(false);
			try {
				await forcePushRepo(repo);
				if (getConfig().showNotifications) { vscode.window.showInformationMessage('Force push completed successfully'); }
			} catch (error) {
				console.error('[ForcePush] Error during per-repo force push:', error);
				showPushErrorPopup(error, 'Failed to force push for the selected repository.');
			} finally {
				isPushing = false;
				updateButtonState();
			}
		})
	);


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
		if (isPushing) { return; }

		isPushing = true;
		setButtonEnabled(false);

		try {
			const gitConfig = vscode.workspace.getConfiguration('git');
			if (!gitConfig.get<boolean>('allowForcePush', false)) {
				vscode.window.showErrorMessage('Force push is disabled. Enable Git: Allow Force Push to continue.');
				return;
			}
			await vscode.commands.executeCommand('git.pushForce');
			if (getConfig().showNotifications) {
				vscode.window.showInformationMessage('Force push completed successfully');
			}
		} catch (error) {
			console.error('[ForcePush] Error during force push:', error);
			const err: any = error as any;
			const details = typeof err === 'string' ? err : (err?.stderr || err?.message || '');
			const message = details ? `Failed to force push: ${details}` : 'Failed to force push. Please check the output panel for details.';
			vscode.window.showErrorMessage(message);
		} finally {
			isPushing = false;
			updateButtonState();
		}
	}

	async function updateButtonState(): Promise<void> {
		try {
			if (isPushing) { setButtonEnabled(false); return; }
			const repos = getGitApi()?.repositories;
			if (!repos?.length) { setButtonEnabled(false); return; }
			const hasIncomingChanges = repos.some((repo: { state: { HEAD?: { behind?: number; upstream?: string } } }) => {
				const head = repo.state.HEAD;
				return Boolean(head?.upstream) && (head?.behind ?? 0) > 0;
			});
			setButtonEnabled(hasIncomingChanges);
		} catch (error) {
			console.error('[ForcePush] Error updating button state:', error);
			setButtonEnabled(false);
		}
	}

	function setButtonEnabled(enabled: boolean): void {
		webviewPanel?.webview.postMessage({ command: 'setEnabled', enabled });
		vscode.commands.executeCommand('setContext', 'forcePushAvailable', enabled);
	}
}

export function deactivate() {
	// Clean up any resources if needed
}
