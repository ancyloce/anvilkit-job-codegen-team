// StageStore (DD-03 §2/§3, delivery.md P12-05): the joint accepted stage of
// a team attempt behind one port — seal it (seal.ts), or recover the proven
// boundary of this attempt from Control's accepted stage (proof.ts).
import type { AcceptedStage, Scope } from "../adapters/sidecar.js";
import { type ProvenStage, proveStage } from "./proof.js";
import { type SealedStage, type SealInput, type StageOptions, sealStage } from "./seal.js";

export class StageStore {
	constructor(private readonly o: StageOptions) {}

	get dir(): string {
		return this.o.dir;
	}

	seal(input: SealInput): Promise<SealedStage> {
		return sealStage(this.o, input);
	}

	/**
	 * Recovery: Control's accepted stage of this attempt first; then every
	 * local object proven against it. Returns the proven boundary, or
	 * undefined when nothing is accepted yet (a fresh start), and throws
	 * StageRefusedError when the local state does not belong to the accepted
	 * stage: no boundary to build on.
	 */
	async recover(scope: Scope): Promise<ProvenStage | undefined> {
		const accepted = await this.o.sidecar.acceptedStage();
		if (!accepted) return undefined;
		return this.prove(accepted, scope);
	}

	prove(accepted: AcceptedStage, scope: Scope): Promise<ProvenStage> {
		return proveStage(this.o.dir, accepted, scope, this.o.teamProfileDigest);
	}
}
