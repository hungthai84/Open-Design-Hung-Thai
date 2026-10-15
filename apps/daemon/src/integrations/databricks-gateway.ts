export function isDatabricksAnthropicGateway(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.pathname.replace(/\/+$/, '') === '/ai-gateway/anthropic/v1';
  } catch {
    return false;
  }
}

export function anthropicGatewayAuthHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  return isDatabricksAnthropicGateway(baseUrl)
    ? { authorization: `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey };
}
