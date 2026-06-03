import type { ResolvedTeamConfig, TeamAvailability, TeamAvailabilityCache } from "./types.ts";
import { memberKey, normalizeLookupName } from "./types.ts";

export interface AvailabilityModelRegistry {
	checkModel(model: string): Promise<{ available: boolean; reason?: string }>;
}

export interface AvailabilityStore {
	hasChecked: boolean;
	cache?: TeamAvailabilityCache;
}

export interface CheckTeamAvailabilityInput {
	team: ResolvedTeamConfig;
	modelRegistry: AvailabilityModelRegistry;
}

export interface CheckAllTeamsAvailabilityInput {
	teams: ReadonlyArray<ResolvedTeamConfig>;
	modelRegistry: AvailabilityModelRegistry;
}

export interface RefreshAvailabilityCacheInput extends CheckAllTeamsAvailabilityInput {
	store: AvailabilityStore;
}

export interface EnsureAvailabilityCheckedInput extends RefreshAvailabilityCacheInput {}

export function createAvailabilityStore(): AvailabilityStore {
	return {
		hasChecked: false,
		cache: undefined,
	};
}

export async function checkTeamAvailability(input: CheckTeamAvailabilityInput): Promise<TeamAvailability> {
	const memberStatuses = await Promise.all(
		input.team.members.map(async (member, index) => {
			const result = await input.modelRegistry.checkModel(member.model);
			return {
				key: memberKey(member.name, member.model, index),
				name: member.name,
				model: member.model,
				available: result.available,
				reason: result.reason,
			};
		}),
	);

	const consensusModel = input.team.consensus.model;
	const consensusResult =
		memberStatuses.find((status) => normalizeLookupName(status.model) === normalizeLookupName(consensusModel)) ??
		(consensusModel
			? await input.modelRegistry.checkModel(consensusModel)
			: { available: false, reason: "missing consensus model" });
	const availableMembers = memberStatuses.filter((status) => status.available);
	const unavailableMembers = memberStatuses.filter((status) => !status.available);

	return {
		team: input.team.name,
		availableMembers,
		unavailableMembers,
		consensusModel,
		consensusModelAvailable: consensusResult.available,
		checkedAt: Date.now(),
	};
}

export async function checkAllTeamsAvailability(input: CheckAllTeamsAvailabilityInput): Promise<TeamAvailability[]> {
	const results = await Promise.all(
		input.teams.map((team) => checkTeamAvailability({ team, modelRegistry: input.modelRegistry })),
	);
	return results.sort((a, b) => a.team.localeCompare(b.team));
}

export async function refreshAvailabilityCache(input: RefreshAvailabilityCacheInput): Promise<TeamAvailabilityCache> {
	const results = await checkAllTeamsAvailability(input);
	const cache: TeamAvailabilityCache = {
		checkedAt: Date.now(),
		byTeam: Object.fromEntries(results.map((result) => [normalizeLookupName(result.team), result])),
	};
	input.store.cache = cache;
	input.store.hasChecked = true;
	return cache;
}

export async function ensureAvailabilityChecked(input: EnsureAvailabilityCheckedInput): Promise<TeamAvailabilityCache> {
	if (input.store.hasChecked && input.store.cache) {
		return input.store.cache;
	}
	return refreshAvailabilityCache(input);
}

export function assertRunnableAvailability(input: {
	team: ResolvedTeamConfig;
	availability: TeamAvailability;
}): void {
	if (input.availability.availableMembers.length < 2) {
		throw new Error(`Team \"${input.team.name}\" cannot run because fewer than 2 members are available.`);
	}
	if (!input.availability.consensusModelAvailable) {
		throw new Error(`Team \"${input.team.name}\" cannot run because the consensus model is unavailable.`);
	}
}
