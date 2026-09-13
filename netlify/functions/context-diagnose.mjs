// Which model IDs can this account actually see?
//
// Added after the first real device: the context-correction provider was
// answered with a 404 for two model IDs in a row, and the console gave no way
// to tell whether the account lacked access or the ID was wrong. This asks the
// provider to report what it can see — offered models, inference profiles, and
// whether the account is authorised for each candidate ID — using the key the
// function already holds. Read-only. GET it in a browser:
//
//   /.netlify/functions/context-diagnose            what the account can see
//   /.netlify/functions/context-diagnose?probe      one-token request to the
//                                                    configured model
//   /.netlify/functions/context-diagnose?probe=<id>  the same, to a chosen ID
//
// Thin, like its siblings: the provider knows the platform; this file does not.
// It asks whichever provider CONTEXT_PROVIDER selects — the same one correction
// is using — so the report is always about the path her sentences take, and
// what each provider can report differs (the README's step 5 reads both).

import * as anthropicClaude from './providers/anthropic-claude.mjs';
import * as bedrockClaude from './providers/bedrock-claude.mjs';

const PROVIDERS = { 'anthropic-claude': anthropicClaude, 'bedrock-claude': bedrockClaude };
const DEFAULT_PROVIDER = 'anthropic-claude';

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET') return fail('method-not-allowed', 'GET only', 405);

  const env = process.env;
  const provider = PROVIDERS[env.CONTEXT_PROVIDER || DEFAULT_PROVIDER];
  if (!provider) return fail('no-provider', 'unknown CONTEXT_PROVIDER', 500);
  if (typeof provider.diagnose !== 'function') {
    return fail('no-diagnosis', 'this provider does not report what it can see', 501);
  }

  const url = new URL(request.url);
  const probe = url.searchParams.has('probe') ? url.searchParams.get('probe') : undefined;

  try {
    const report = await provider.diagnose({ env, probe });
    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    console.error('diagnosis failed', e && e.message);
    return fail('diagnosis-failed', 'could not build the report', 502);
  }
}

function fail(error, message, status) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
