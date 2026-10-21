// Print-on-demand mode. Open the demo with ?provider=printful or
// ?provider=printify and the shop's print step talks to that provider for real
// through the backend in ../server, which holds the API tokens:
//
//   - the print area on the shirt takes the provider's real print file size
//   - "Send to …" exports the artwork and gets the provider's own mockups back
//
// Nothing is ordered. Without the query parameter the demo is the plain
// customizer with PDF / PNG downloads.

const PROVIDERS = {
  printful: { id: 'printful', name: 'Printful', send: 'mockups' },
  printify: { id: 'printify', name: 'Printify', send: 'mockups' },
  // Teemill turns the front design into a buyable product page.
  teemill: { id: 'teemill', name: 'Teemill', send: 'product' },
  fourthwall: { id: 'fourthwall', name: 'Fourthwall', send: 'mockups' },
};

export const PROVIDER =
  PROVIDERS[new URLSearchParams(window.location.search).get('provider')] || null;

const API = (import.meta.env.VITE_POD_API || 'http://localhost:8787').replace(/\/$/, '');

async function call(path, options) {
  const res = await fetch(API + path, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${PROVIDER.name} request failed`);
  return json;
}

/** The provider's print area for the demo tee: { areas: { front, back }, request }. */
export const fetchPrintArea = (colorId) =>
  call(`/${PROVIDER.id}/print-area?color=${encodeURIComponent(colorId)}`);

/**
 * Send the exported sides; returns { mockups: [{ side, url }], requests } and,
 * for Teemill, the productUrl of the page it created.
 */
export const sendDesign = (files, colorId) =>
  call(`/${PROVIDER.id}/${PROVIDER.send}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color: colorId, files }),
  });
