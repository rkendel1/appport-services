/**
 * AuthBoundry authorization protocol.
 *
 * The request and decision shapes follow the AuthBoundry authorization
 * contract (`AuthorizationRequest` / `AuthorizationDecision` in
 * @feltdb/core). AppPort Services ships no implementation: the host supplies
 * an AuthBoundry client. Services never evaluate policy and never cache the
 * answer.
 */
export interface AuthorizationSubject {
  readonly kind: string;
  readonly id: string;
}

export interface AuthorizationResource {
  readonly uri: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ServiceAuthorizationRequest {
  readonly request_id: string;
  readonly subject: AuthorizationSubject;
  readonly tenant_id: string;
  readonly application_id: string;
  readonly capability: string;
  readonly capability_version: number;
  readonly resource: AuthorizationResource;
  readonly context: {
    readonly timestamp: number;
    readonly execution_id?: string;
    readonly delegation_id?: string;
    readonly run_id?: string;
    readonly credential_id?: string;
    readonly verified_by: string;
  };
}

export interface ServiceAuthorizationDecision {
  readonly decision_id: string;
  readonly allowed: boolean;
  readonly capability: string;
  readonly tenant_id: string;
  readonly application_id: string;
  readonly subject: AuthorizationSubject;
  readonly resource: AuthorizationResource;
  readonly reason?: string;
  readonly policy_version?: string;
  readonly evaluated_at?: number;
}

/** Host-supplied AuthBoundry client. Throwing means authority is unavailable. */
export interface ServiceAuthorizer {
  authorize(request: ServiceAuthorizationRequest, options: { readonly signal: AbortSignal }): Promise<ServiceAuthorizationDecision>;
}
