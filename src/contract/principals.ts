export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly principalType: 'api_key';
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly credentialId: string;
}
