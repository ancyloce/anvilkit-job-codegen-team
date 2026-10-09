// The independent validation port (DD-04 §3, delivery.md P12-06): the
// sealed source of a round goes through the validator's own chain
// (jobs/validator: complete-source contract, protected build, independent
// certification) and comes back classified by the validator profile's fixed
// map — certified, repairable, invalid, infrastructure_failed. Only a
// repairable result may send the team back to the coder; nothing the team
// itself concludes is a certification. The validator's own chain is the
// adapter in adapters/validator.ts.
import type { ComponentIdentity } from "./identity.js";
import type { SealedSource } from "./source.js";

export interface CertificationSummary {
	verdict: string;
	failureCode?: string;
	complete: boolean;
	checks: Array<{ name: string; status: string; detail?: string }>;
	bindings: Record<string, unknown>;
	/** sha256 of certification.json as written by the validator. */
	digest: string;
	/** Where the validator's run directory is (the certification and evidence files). */
	dir: string;
}

export type ValidationResult =
	| { status: "certified"; certification: CertificationSummary }
	| { status: "repairable"; failureCode: string; detail: string; certification: CertificationSummary }
	| { status: "invalid"; failureCode: string; detail: string; certification: CertificationSummary }
	| { status: "infrastructure_failed"; failureCode: string; detail: string; certification?: CertificationSummary }
	| { status: "unavailable"; reason: string };

export interface ValidationInput {
	round: number;
	sealedDir: string;
	source: SealedSource;
	sourceRevision: string;
	/** The allocated identity the sealed source declares (checked by the coordinator before validation) and a certification binds. */
	identity: ComponentIdentity;
}

export interface ValidationPort {
	validate(input: ValidationInput, signal?: AbortSignal): Promise<ValidationResult>;
}

/** No validator in this environment: the team cannot classify and never certifies. */
export class UnavailableValidation implements ValidationPort {
	constructor(private readonly reason: string) {}
	async validate(): Promise<ValidationResult> {
		return { status: "unavailable", reason: this.reason };
	}
}
