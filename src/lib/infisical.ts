import { InfisicalSDK } from "@infisical/sdk";

let client: InfisicalSDK | null = null;

export async function getInfisicalClient(): Promise<InfisicalSDK> {
  if (client) return client;

  client = new InfisicalSDK({
    siteUrl: process.env.INFISICAL_SITE_URL ?? "http://localhost:8080",
  });

  await client.auth().universalAuth.login({
    clientId: process.env.INFISICAL_CLIENT_ID!,
    clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
  });

  return client;
}

// Fetch-use-discard pattern: retrieve secret, return value, never cache
export async function fetchSecret(
  projectId: string,
  environment: string,
  secretPath: string,
  secretName: string,
): Promise<string> {
  const sdk = await getInfisicalClient();
  const secret = await sdk.secrets().getSecret({
    projectId,
    environment,
    secretPath,
    secretName,
  });
  return secret.secretValue;
}

// Store a secret in Infisical
export async function storeSecret(
  projectId: string,
  environment: string,
  secretPath: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  const sdk = await getInfisicalClient();

  try {
    // Try update first
    await sdk.secrets().updateSecret({
      projectId,
      environment,
      secretPath,
      secretName,
      secretValue,
    });
  } catch {
    // Create if doesn't exist
    await sdk.secrets().createSecret({
      projectId,
      environment,
      secretPath,
      secretName,
      secretValue,
    });
  }
}
