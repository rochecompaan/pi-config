export type QuickfixLifecycleStepResult =
	| { ok: true }
	| { ok: false; error: string; cancelled?: boolean; recoverable?: boolean };

export type StartQuickfixActions = {
	navigateToBranch: () => Promise<QuickfixLifecycleStepResult>;
	activateEntering: () => void;
	dispatchInitialPrompt: () => Promise<void>;
	recoverEditor: () => void;
};

export type FinishQuickfixActions = {
	waitForIdle: () => Promise<void>;
	markReturning: () => void;
	navigateToOrigin: () => Promise<QuickfixLifecycleStepResult>;
	restoreActive: () => void;
	clearActive: () => void;
};

export async function startQuickfixLifecycle(
	actions: StartQuickfixActions,
): Promise<QuickfixLifecycleStepResult> {
	const navigation = await actions.navigateToBranch();
	if (!navigation.ok) return navigation;

	actions.activateEntering();
	try {
		await actions.dispatchInitialPrompt();
		return { ok: true };
	} catch (error) {
		actions.recoverEditor();
		return {
			ok: false,
			error: `Failed to submit the quick-fix request: ${error instanceof Error ? error.message : String(error)}`,
			recoverable: true,
		};
	}
}

export async function finishQuickfixLifecycle(
	actions: FinishQuickfixActions,
): Promise<QuickfixLifecycleStepResult> {
	try {
		await actions.waitForIdle();
	} catch (error) {
		return {
			ok: false,
			error: `Failed to wait for idle state: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	actions.markReturning();
	const navigation = await actions.navigateToOrigin();
	if (!navigation.ok) {
		actions.restoreActive();
		return navigation;
	}
	actions.clearActive();
	return { ok: true };
}
