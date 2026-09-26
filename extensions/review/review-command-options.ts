const EXTRA_OPTION = "--extra";
const EXTRA_OPTION_ERROR = "--extra is no longer supported.";

export function getUnsupportedReviewOptionError(parts: readonly string[]): string | undefined {
	const hasExtraOption = parts.some((part) => part === EXTRA_OPTION || part.startsWith(`${EXTRA_OPTION}=`));
	return hasExtraOption ? EXTRA_OPTION_ERROR : undefined;
}
