/**
 * Shared helpers for the `vertexai` BYOK protocol.
 *
 * Vertex AI authenticates through Application Default Credentials — no API
 * key exists for it. On the deployed studio VM (GCE, container attached to
 * the instance service account) ADC resolves via the metadata server, which
 * is the only path implemented here; a local `opencode run` against a
 * developer laptop needs its own ADC and is not this module's concern.
 *
 * Endpoint shape (verified 2026-10-13 against the od-studio deployment):
 * Gemini 3.x publisher models are served from the *global* endpoint
 * `https://aiplatform.googleapis.com` and are NOT available on regional
 * hosts like `us-central1-aiplatform.googleapis.com` (those return
 * `Publisher model ... was not found`). `locations/global` in the path is
 * accepted by the global host, so `location: "global"` is the default.
 */

import type { ByokChatProviderConfig } from '@open-design/contracts';

export const VERTEX_DEFAULT_LOCATION = 'global';
const VERTEX_GLOBAL_HOST = 'https://aiplatform.googleapis.com';
const VERTEX_API_VERSION = 'v1beta1';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface VertexAiConfig {
  project: string;
  location: string;
}

/** Resolve the GCP project/location for a run: config fields win, daemon env
 *  vars (set by the Pulumi deployment) are the fallback, `global` is the
 *  location default. Returns null when no project is resolvable — callers
 *  treat that as "provider not configured". */
export function resolveVertexAiConfig(
  provider: Pick<
    ByokChatProviderConfig,
    'gcpProject' | 'gcpLocation'
  > | null | undefined,
): VertexAiConfig | null {
  const project =
    provider?.gcpProject?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    '';
  const location =
    provider?.gcpLocation?.trim() ||
    process.env.GOOGLE_CLOUD_LOCATION?.trim() ||
    VERTEX_DEFAULT_LOCATION;
  if (!project) return null;
  return { project, location };
}

/** REST generateContent endpoint for a publisher model on the global host.
 *  Works for `:generateContent` and `:streamGenerateContent` alike (the
 *  caller appends the method). */
export function vertexPublisherModelUrl(
  config: VertexAiConfig,
  model: string,
): string {
  return `${VERTEX_GLOBAL_HOST}/${VERTEX_API_VERSION}/projects/${encodeURIComponent(
    config.project,
  )}/locations/${encodeURIComponent(config.location)}/publishers/google/models/${encodeURIComponent(
    model,
  )}`;
}

/** Build the generateContent request body in the Vertex (stricter) shape:
 *  unlike the Gemini API, Vertex requires an explicit `role` on contents. */
export function vertexGenerateContentBody(
  userPrompt: string,
  systemPrompt?: string,
  maxOutputTokens?: number,
): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    ...(systemPrompt
      ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
      : {}),
    ...(maxOutputTokens
      ? { generationConfig: { maxOutputTokens } }
      : {}),
  };
}

/** Fetch an access token from the GCE metadata server (the instance's
 *  attached service account). Returns null when the metadata server is not
 *  reachable — e.g. a daemon running outside GCE — and the caller maps that
 *  to an auth/connection error, never a silent fallback to some other
 *  provider. Tokens live ~1h; callers must fetch per request batch, not
 *  cache across runs. */
export async function getVertexAccessToken(): Promise<string | null> {
  try {
    const response = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: unknown };
    return typeof data.access_token === 'string' && data.access_token
      ? data.access_token
      : null;
  } catch {
    return null;
  }
}