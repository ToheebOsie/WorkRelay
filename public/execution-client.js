export function createExecutionClient(fetchImpl = fetch) {
  async function request(path, options = {}) {
    let response;
    try { response = await fetchImpl(path, { cache: 'no-store', ...options }); }
    catch (error) { throw new Error(`Network error: ${error.message}`); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Server returned an invalid response (${response.status}).`); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  const post = (path, body = {}) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return {
    get: (id) => request(`/api/execution/${encodeURIComponent(id)}`),
    sync: (id) => post(`/api/execution/${encodeURIComponent(id)}/sync`),
    dispatch: (id, previewFingerprint) => post(`/api/execution/${encodeURIComponent(id)}/dispatch`, { confirmed: true, previewFingerprint }),
    recover: (id) => post(`/api/execution/${encodeURIComponent(id)}/recover`),
    reconcile: (id, input) => post(`/api/execution/${encodeURIComponent(id)}/reconcile`, { ...input, confirmed: true }),
    evaluate: (id, packageId) => post(`/api/execution/${encodeURIComponent(id)}/evaluate`, { packageId }),
    accept: (id, packageId) => post(`/api/execution/${encodeURIComponent(id)}/accept`, { packageId, accepted: true })
  };
}
