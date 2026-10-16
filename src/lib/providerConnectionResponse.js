import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  if (!connection.providerSpecificData) {
    return safe;
  }

  const {
    sessionToken, zcodeJwtToken, zaiBusinessToken, zaiRefreshToken,
    ...providerSpecificData
  } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
