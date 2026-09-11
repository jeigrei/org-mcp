import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessClaims {
  /** The raw identity claim: a Service Token's name, or a logged-in user's email. */
  label: string;
  /** Which claim the label came from — useful when diagnosing identity-map gaps. */
  claimSource: "common_name" | "email" | "sub";
}

/**
 * Builds a verifier for Cloudflare Access JWTs (the `Cf-Access-Jwt-Assertion` header
 * Access adds to every request it lets through — for Service Tokens, browser logins, and
 * the Managed OAuth flow alike).
 *
 * `teamDomain` is your Zero Trust team domain, e.g. "myteam.cloudflareaccess.com".
 * `aud` is the Access Application's Audience (AUD) tag, from the app's Overview page.
 */
export function createAccessVerifier(
  teamDomain: string,
  aud: string
): (token: string) => Promise<AccessClaims> {
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));

  return async function verify(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, jwks, {
      audience: aud,
      issuer: `https://${teamDomain}`,
    });

    // Service Tokens carry `common_name` (the token's name in the Zero Trust dashboard);
    // interactively authenticated users carry `email`. Fall back to `sub` if neither is present.
    if (typeof payload.common_name === "string" && payload.common_name) {
      return { label: payload.common_name, claimSource: "common_name" };
    }
    if (typeof payload.email === "string" && payload.email) {
      return { label: payload.email, claimSource: "email" };
    }
    if (typeof payload.sub === "string" && payload.sub) {
      return { label: payload.sub, claimSource: "sub" };
    }
    throw new Error("Access token has no common_name, email, or sub claim to identify the user.");
  };
}
