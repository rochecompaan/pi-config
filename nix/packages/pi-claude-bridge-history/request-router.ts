export type BridgeRequestHandlers<TContext, TResult> = {
	isolated: (context: TContext) => TResult;
	agent: (context: TContext) => TResult;
};

export type BridgeRequestOptions = {
	cacheRetention?: string;
};

export function routeBridgeRequest<TContext, TResult>(
	context: TContext,
	handlers: BridgeRequestHandlers<TContext, TResult>,
	options: BridgeRequestOptions = {},
): TResult {
	return options.cacheRetention === "none"
		? handlers.isolated(context)
		: handlers.agent(context);
}
