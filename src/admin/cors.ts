const DEV_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  if (origin && DEV_ORIGINS.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Secret',
      'Access-Control-Max-Age': '86400',
    };
  }
  return {};
}

export function jsonResponse(request: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

export function optionsResponse(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
