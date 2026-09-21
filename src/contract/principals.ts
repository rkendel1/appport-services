export interface AuthenticatedPrincipal {
  readonly principalId: string;
  /** Host-defined identity kind. AppPort Services never grants authority from it. */
  readonly principalType: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  /** Present for principals authenticated with an AppPort API key. */
  readonly credentialId?: string;
}
