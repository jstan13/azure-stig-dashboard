/**
 * Cloud-aware Azure SDK client options.
 *
 * `DefaultAzureCredential` already honors the `AZURE_AUTHORITY_HOST` env var
 * for token acquisition, but the ARM management plane clients
 * (ResourceGraph, ARM, Compute, etc.) default to `https://management.azure.com`
 * which does not work in Azure US Government (`management.usgovcloudapi.net`)
 * or Azure China. The ARM/Bicep templates set `AZURE_ARM_ENDPOINT` so this
 * helper returns a `{ endpoint }` options bag that every client constructor
 * can accept.
 *
 * Usage:
 *   import { azureClientOptions } from '../connectors/azureClientOptions';
 *   new ResourceGraphClient(new DefaultAzureCredential(), azureClientOptions());
 */
export interface AzureClientOptions {
  endpoint?: string;
}

export function azureClientOptions(): AzureClientOptions {
  const endpoint = process.env.AZURE_ARM_ENDPOINT;
  return endpoint ? { endpoint } : {};
}

/** Convenience accessor for the Microsoft Graph endpoint (Commercial vs Gov). */
export function azureGraphEndpoint(): string {
  return process.env.AZURE_GRAPH_ENDPOINT ?? 'https://graph.microsoft.com';
}

/** Convenience accessor for the Microsoft Entra authority. */
export function azureAuthorityHost(): string {
  return (process.env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
}
