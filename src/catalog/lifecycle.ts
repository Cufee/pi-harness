// Audit date 2026-11-21. These exact IDs have vendor-documented upgrades.
// Successors describe the default catalog. A provider may still serve the old ID.
export const vendorSuccessors: ReadonlyMap<string, string> = new Map<string, string>([
  // https://developers.openai.com/api/docs/deprecations
  ["openai/gpt-5.3-codex", "openai/gpt-6-sol"],
  ["openai/gpt-5.2-codex", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.1-codex", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.1-codex-max", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.1-codex-mini", "openai/gpt-5.6-terra"],
  ["openai/gpt-5-codex", "openai/gpt-5.6-sol"],
  ["openai/gpt-5-mini", "openai/gpt-6.1-terra"],
  ["openai/gpt-5-mini-2025-08-07", "openai/gpt-6.1-terra"],
  ["openai/gpt-5-nano", "openai/gpt-6-luna"],
  ["openai/gpt-5-nano-2025-08-07", "openai/gpt-6-luna"],
  ["openai/o3", "openai/gpt-6.1-sol"],
  ["openai/o3-2025-04-16", "openai/gpt-6.1-sol"],
  // https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6
  // GPT-5.5 remains available through the API. Sol is its flagship migration target.
  ["openai/gpt-5.5", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.5-2026-04-23", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.4", "openai/gpt-5.6-sol"],
  ["openai/gpt-5.6", "openai/gpt-5.6-sol"],
  // Same-product releases in https://developers.openai.com/api/docs/changelog
  ["openai/gpt-6-astra", "openai/gpt-6.2-astra"],
  ["openai/gpt-6-sol", "openai/gpt-6.1-sol"],
  ["openai/gpt-6.1-sol", "openai/gpt-6.2-sol"],
  // OpenAI's Codex CLI 0.167.0: codex debug models --bundled, models[].upgrade.model
  ["openai/gpt-5.6-sol", "openai/gpt-6-sol"],
  ["openai/gpt-5.6-terra", "openai/gpt-6-sol"],
  ["openai/gpt-5.6-luna", "openai/gpt-6-luna"],
  // https://aistudio.google.com/docs/choosing-a-model#upgrade-paths
  ["google/gemini-3.8-flash", "google/gemini-4-hydrogen"],
  ["google/gemini-3.6-flash", "google/gemini-4-hydrogen"],
  ["google/gemini-3-flash-preview", "google/gemini-4-hydrogen"],
  ["google/gemini-3.1-pro-preview", "google/gemini-4-neon"],
  ["google/gemini-3.1-flash-lite", "google/gemini-3.5-flash-lite"],
  // https://aistudio.google.com/docs/deprecations
  ["google/gemini-3.7-flash", "google/gemini-3.8-flash"],
  ["google/gemini-3.5-flash", "google/gemini-3.6-flash"],
  ["google/gemini-2.5-pro", "google/gemini-3.8-flash"],
  ["google/gemini-2.5-flash", "google/gemini-3.5-flash-lite"],
]);

export function stripRoutingSuffix(id: string): string {
  return id.replace(/(?::(?:free|batch|exacto|nitro|floor)|@default)$/i, "");
}

const providers = new Map([
  ["google-vertex", "google"],
  ["gemini", "google"],
  ["codex", "openai"],
  ["claude", "anthropic"],
  ["zhipuai", "zai"], // https://www.zhipuai.cn/en
]);

export function canonicalModelId(wireId: string, provider: string): string {
  const id = stripRoutingSuffix(wireId.trim().toLowerCase());
  const slash = id.indexOf("/");
  if (slash >= 0) {
    const namespace = id.slice(0, slash);
    return (providers.get(namespace) ?? namespace) + id.slice(slash);
  }
  // Native CLIs can expose other vendors' models by their bare product IDs.
  const adapter = provider.toLowerCase().replace(/^acp:/, "");
  if (["claude", "gemini", "codex", "generic"].includes(adapter)) {
    if (/^claude-/.test(id)) return "anthropic/" + id;
    if (/^(?:gpt-|o[134](?:-|$))/.test(id)) return "openai/" + id;
    if (/^gemini-/.test(id)) return "google/" + id;
    if (/^glm-/.test(id)) return "zai/" + id;
  }
  return (providers.get(adapter) ?? adapter) + "/" + id;
}
