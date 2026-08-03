export type ReviewLifecycleStepResult =
	| { ok: true }
	| { ok: false; error: string; cancelled?: boolean };

export type ReviewLifecycleValueResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; cancelled?: boolean };

type StartReviewLifecycleActions = {
	navigateToReview: () => Promise<ReviewLifecycleStepResult>;
	switchReviewModel: () => Promise<ReviewLifecycleStepResult>;
	rollbackToOrigin: () => Promise<ReviewLifecycleStepResult>;
	restoreOriginModel: () => Promise<ReviewLifecycleStepResult>;
	activateAndDispatch: () => Promise<void>;
};

type FinishReviewLifecycleActions<T> = {
	navigateToOrigin: () => Promise<ReviewLifecycleValueResult<T>>;
	restoreOriginModel: () => Promise<ReviewLifecycleStepResult>;
	rollbackToReview: () => Promise<ReviewLifecycleStepResult>;
};

export async function startReviewLifecycle(
	actions: StartReviewLifecycleActions,
): Promise<ReviewLifecycleStepResult> {
	const navigation = await actions.navigateToReview();
	if (!navigation.ok) return navigation;

	const modelSwitch = await actions.switchReviewModel();
	if (!modelSwitch.ok) {
		const rollbackFailures: string[] = [];
		const rollback = await actions.rollbackToOrigin();
		if (!rollback.ok) rollbackFailures.push(rollback.error);
		const restoration = await actions.restoreOriginModel();
		if (!restoration.ok) rollbackFailures.push(restoration.error);
		return rollbackFailures.length > 0
			? { ok: false, error: `${modelSwitch.error}. Rollback problems: ${rollbackFailures.join("; ")}` }
			: modelSwitch;
	}

	await actions.activateAndDispatch();
	return { ok: true };
}

export async function finishReviewLifecycle<T>(
	actions: FinishReviewLifecycleActions<T>,
): Promise<ReviewLifecycleValueResult<T>> {
	const navigation = await actions.navigateToOrigin();
	if (!navigation.ok) return navigation;

	const restoration = await actions.restoreOriginModel();
	if (restoration.ok) return navigation;

	const rollback = await actions.rollbackToReview();
	return rollback.ok
		? {
			ok: false,
			error: `${restoration.error}. Returned to the review branch; repair authentication and retry /end-review.`,
		}
		: {
			ok: false,
			error: `${restoration.error}. Failed to return to the review branch: ${rollback.error}`,
		};
}
