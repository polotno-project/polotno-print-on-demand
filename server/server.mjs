// A small backend for the Polotno print-on-demand demos.
//
// The demos run in the browser, so they cannot hold a Printful or Printify API
// token. This server holds both and exposes four routes the demos call:
//
//   GET  /printful/print-area   real print file size for the demo tee
//   POST /printful/mockups      render the customer's design with Printful's
//                               mockup generator
//   GET  /printify/print-area   real print area for the demo tee
//   POST /printify/mockups      upload the design, create a draft product in
//                               the test shop, return Printify's mockups, then
//                               delete the draft
//   POST /lulu/check-cover      ask Lulu for the cover size it expects and
//                               validate the exported cover PDF against it
//   GET  /teemill/print-area    the export size for Teemill's tee
//   POST /teemill/product       turn the design into a buyable Teemill product
//                               page with Teemill's Custom Product endpoint
//   GET  /fourthwall/print-area real print areas of the demo tee
//   POST /fourthwall/mockups    create a hidden design product in the shop,
//                               return Fourthwall's mockups, then delete it
//   GET  /spreadconnect/print-area real print areas of the demo tee
//   POST /spreadconnect/mockups upload each side and get Spreadconnect's
//                               product previews (read-only, nothing created
//                               but the uploaded design files)
//   GET  /peecho/product        the demo art print from Peecho's catalog
//   POST /peecho/order          create a test order for the print PDF in
//                               Peecho's test environment (never paid, so
//                               never printed)
//
// Nothing is ordered. Mockups are free on Printful, and the Printify draft is
// deleted as soon as its mockups are read.
//
// Env:
//   PRINTFUL_TOKEN, PRINTFUL_STORE_ID (needed for account-level tokens)
//   PRINTIFY_TOKEN, PRINTIFY_SHOP_ID
//   LULU_CLIENT_KEY, LULU_CLIENT_SECRET, LULU_API (defaults to the sandbox)
//   TEEMILL_PUBLIC_KEY
//   FOURTHWALL_USERNAME, FOURTHWALL_PASSWORD (shop API credentials)
//   PEECHO_API_KEY (test environment), PEECHO_API (defaults to test)
//   SPREADCONNECT_LIVE_API_KEY (previews only render on the live image server)
//   PUBLIC_URL     this server's public URL; Printful downloads files from it
//   ALLOWED_ORIGINS comma-separated, defaults to polotno.com and localhost

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = (
  env.ALLOWED_ORIGINS ||
  'https://polotno.com,https://www.polotno.com,http://localhost:3000,http://localhost:5173'
).split(',');

// The demo sells one tee: Bella+Canvas 3001 on both platforms. Colours map to
// the names each catalog uses. Overridable per env if a catalog changes.
const PRINTFUL_PRODUCT_ID = Number(env.PRINTFUL_PRODUCT_ID || 71);
const PRINTIFY_BLUEPRINT_ID = Number(env.PRINTIFY_BLUEPRINT_ID || 12);
const PRINTIFY_PROVIDER_ID = env.PRINTIFY_PROVIDER_ID
  ? Number(env.PRINTIFY_PROVIDER_ID)
  : null;
const SIZE = env.DEMO_SIZE || 'M';
const COLORS = { black: 'Black', blue: 'True Royal', red: 'Red' };
const SIDES = ['front', 'back'];

const MAX_BODY = 25 * 1024 * 1024;
const FILE_TTL_MS = 10 * 60 * 1000;

// --- helpers ------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cached(fn, ttlMs = 60 * 60 * 1000) {
  const cache = new Map();
  return async (key) => {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await fn(key);
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  };
}

async function api(base, token, path, { method = 'GET', body, headers = {} } = {}) {
  // A provider with its own auth header passes Authorization: undefined.
  const allHeaders = Object.fromEntries(
    Object.entries({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }).filter(
      ([, v]) => v !== undefined
    )
  );
  const res = await fetch(base + path, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || json?.result || text;
    throw new HttpError(502, `${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

const printful = (path, opts = {}) => {
  if (!env.PRINTFUL_TOKEN) throw new HttpError(503, 'PRINTFUL_TOKEN is not set');
  const headers = env.PRINTFUL_STORE_ID ? { 'X-PF-Store-Id': env.PRINTFUL_STORE_ID } : {};
  return api('https://api.printful.com', env.PRINTFUL_TOKEN, path, {
    ...opts,
    headers: { ...headers, ...opts.headers },
  });
};

const printify = (path, opts) => {
  if (!env.PRINTIFY_TOKEN) throw new HttpError(503, 'PRINTIFY_TOKEN is not set');
  return api('https://api.printify.com/v1', env.PRINTIFY_TOKEN, path, opts);
};

const colorName = (id) => {
  const name = COLORS[id];
  if (!name) throw new HttpError(400, `Unknown color "${id}"`);
  return name;
};

// The demo posts base64 PNGs per side. Keep only real, non-empty PNG data.
function readSides(body) {
  const sides = {};
  for (const side of SIDES) {
    const value = body?.files?.[side];
    if (!value) continue;
    const base64 = String(value).replace(/^data:image\/png;base64,/, '');
    if (!base64.startsWith('iVBOR')) throw new HttpError(400, `${side} is not a PNG`);
    sides[side] = base64;
  }
  if (!Object.keys(sides).length) throw new HttpError(400, 'No design to send');
  return sides;
}

// --- temporary file hosting (Printful downloads print files by URL) -----------

const files = new Map();

const FILE_TYPES = { png: 'image/png', pdf: 'application/pdf' };

function hostFile(base64, ext = 'png') {
  const id = randomUUID();
  files.set(id, { data: Buffer.from(base64, 'base64'), ext, expires: Date.now() + FILE_TTL_MS });
  return `${PUBLIC_URL}/files/${id}.${ext}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, f] of files) if (f.expires < now) files.delete(id);
}, 60 * 1000).unref();

// --- Printful -------------------------------------------------------------------

const printfulCatalog = cached(async () => {
  const [{ result: product }, { result: printfiles }] = await Promise.all([
    printful(`/products/${PRINTFUL_PRODUCT_ID}`),
    printful(`/mockup-generator/printfiles/${PRINTFUL_PRODUCT_ID}`),
  ]);
  return { product, printfiles };
});

async function printfulVariant(colorId) {
  const { product, printfiles } = await printfulCatalog('catalog');
  const color = colorName(colorId);
  const variant = product.variants.find((v) => v.color === color && v.size === SIZE);
  if (!variant) throw new HttpError(502, `Printful has no ${color} / ${SIZE} variant`);
  const mapping = printfiles.variant_printfiles.find((v) => v.variant_id === variant.id);
  const areas = {};
  for (const side of SIDES) {
    const id = mapping?.placements?.[side];
    const file = printfiles.printfiles.find((p) => p.printfile_id === id);
    if (file) areas[side] = { width: file.width, height: file.height, dpi: file.dpi };
  }
  return { variant, areas };
}

async function printfulPrintArea(query) {
  const { variant, areas } = await printfulVariant(query.get('color') || 'black');
  return {
    product: `${PRINTFUL_PRODUCT_ID}`,
    variant: { id: variant.id, name: variant.name },
    areas,
    request: `GET https://api.printful.com/mockup-generator/printfiles/${PRINTFUL_PRODUCT_ID}`,
  };
}

async function printfulMockups(body) {
  const sides = readSides(body);
  const { variant, areas } = await printfulVariant(body.color || 'black');
  const taskBody = {
    variant_ids: [variant.id],
    format: 'jpg',
    // A flat shot, one on a model and one lifestyle, only for designed sides.
    options: Object.keys(sides).map((side) => (side === 'back' ? 'Back' : 'Front')),
    option_groups: ['Flat', "Men's", "Women's Lifestyle"],
    files: Object.entries(sides).map(([side, base64]) => ({
      placement: side,
      image_url: hostFile(base64),
      position: {
        area_width: areas[side].width,
        area_height: areas[side].height,
        width: areas[side].width,
        height: areas[side].height,
        top: 0,
        left: 0,
      },
    })),
  };
  const { result: task } = await printful(
    `/mockup-generator/create-task/${PRINTFUL_PRODUCT_ID}`,
    { method: 'POST', body: taskBody }
  );

  // The generator is asynchronous: poll until the mockups are ready.
  const started = Date.now();
  let status = task;
  while (status.status === 'pending' && Date.now() - started < 60 * 1000) {
    await sleep(2000);
    ({ result: status } = await printful(
      `/mockup-generator/task?task_key=${encodeURIComponent(task.task_key)}`
    ));
  }
  if (status.status !== 'completed') {
    throw new HttpError(502, `Printful mockup task ${status.status}: ${status.error || ''}`);
  }

  return {
    variant: { id: variant.id, name: variant.name },
    // The main render per side, plus the model and lifestyle shots.
    mockups: status.mockups
      .flatMap((m) => [
        { side: m.placement, url: m.mockup_url },
        ...(m.extra || []).map((x) => ({ side: x.title || x.option, url: x.url })),
      ])
      .slice(0, 4),
    requests: [
      {
        title: 'Render mockups of the design',
        endpoint: `POST https://api.printful.com/mockup-generator/create-task/${PRINTFUL_PRODUCT_ID}`,
        body: taskBody,
      },
      {
        title: 'Then order it: same files, same placements',
        endpoint: 'POST https://api.printful.com/orders',
        body: {
          recipient: { name: '…', address1: '…', city: '…', country_code: '…', zip: '…' },
          items: [
            {
              variant_id: variant.id,
              quantity: 1,
              files: taskBody.files.map(({ placement, image_url, position }) => ({
                type: placement,
                url: image_url,
                position,
              })),
            },
          ],
        },
      },
    ],
  };
}

// --- Printify -------------------------------------------------------------------

const printifyCatalog = cached(async () => {
  let providerId = PRINTIFY_PROVIDER_ID;
  if (!providerId) {
    const providers = await printify(
      `/catalog/blueprints/${PRINTIFY_BLUEPRINT_ID}/print_providers.json`
    );
    providerId = providers[0]?.id;
  }
  const { variants } = await printify(
    `/catalog/blueprints/${PRINTIFY_BLUEPRINT_ID}/print_providers/${providerId}/variants.json`
  );
  return { providerId, variants };
});

async function printifyVariant(colorId) {
  const { providerId, variants } = await printifyCatalog('catalog');
  const color = colorName(colorId);
  const variant = variants.find(
    (v) => v.options?.color === color && v.options?.size === SIZE
  );
  if (!variant) throw new HttpError(502, `Printify has no ${color} / ${SIZE} variant`);
  const areas = {};
  for (const p of variant.placeholders || []) {
    if (SIDES.includes(p.position)) areas[p.position] = { width: p.width, height: p.height };
  }
  return { providerId, variant, areas };
}

async function printifyPrintArea(query) {
  const { providerId, variant, areas } = await printifyVariant(query.get('color') || 'black');
  return {
    blueprint: PRINTIFY_BLUEPRINT_ID,
    provider: providerId,
    variant: { id: variant.id, name: variant.title },
    areas,
    request: `GET https://api.printify.com/v1/catalog/blueprints/${PRINTIFY_BLUEPRINT_ID}/print_providers/${providerId}/variants.json`,
  };
}

// The test shop: PRINTIFY_SHOP_ID, or the account's first shop.
const printifyShop = cached(async () => {
  if (env.PRINTIFY_SHOP_ID) return env.PRINTIFY_SHOP_ID;
  const shops = await printify('/shops.json');
  if (!shops[0]) throw new HttpError(503, 'The Printify account has no shop');
  return shops[0].id;
});

async function printifyMockups(body) {
  const shop = await printifyShop('shop');
  const sides = readSides(body);
  const { providerId, variant } = await printifyVariant(body.color || 'black');

  const uploads = {};
  for (const [side, base64] of Object.entries(sides)) {
    uploads[side] = await printify('/uploads/images.json', {
      method: 'POST',
      body: { file_name: `polotno-demo-${side}.png`, contents: base64 },
    });
  }

  const productBody = {
    title: 'Polotno demo tee (draft)',
    description: 'Created by the Polotno SDK demo and deleted right after.',
    blueprint_id: PRINTIFY_BLUEPRINT_ID,
    print_provider_id: providerId,
    variants: [{ id: variant.id, price: 2499, is_enabled: true }],
    print_areas: [
      {
        variant_ids: [variant.id],
        placeholders: Object.entries(uploads).map(([side, upload]) => ({
          position: side,
          images: [{ id: upload.id, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        })),
      },
    ],
  };
  const product = await printify(`/shops/${shop}/products.json`, {
    method: 'POST',
    body: productBody,
  });

  try {
    // Printify renders dozens of shots per product. Keep the flat front and
    // back (when there is a back design), one on a model and one lifestyle.
    const wanted = ['front', ...(sides.back ? ['back'] : []), 'person-1', 'lifestyle'];
    const labelOf = (src) => new URL(src).searchParams.get('camera_label');
    const images = wanted
      .map((label) =>
        (product.images || []).find(
          (img) => img.variant_ids?.includes(variant.id) && labelOf(img.src) === label
        )
      )
      .filter(Boolean)
      .map((img) => ({ side: labelOf(img.src).replace('person-1', 'on a model'), url: img.src }));
    return {
      variant: { id: variant.id, name: variant.title },
      mockups: images,
      requests: [
        {
          title: 'Upload the artwork (one per side)',
          endpoint: 'POST https://api.printify.com/v1/uploads/images.json',
          body: { file_name: 'design-front.png', contents: '<base64 PNG>' },
        },
        {
          title: 'Create the product with it on the print areas',
          endpoint: `POST https://api.printify.com/v1/shops/{shop_id}/products.json`,
          body: productBody,
        },
      ],
    };
  } finally {
    // The demo only needs the mockups; leave the test shop clean.
    printify(`/shops/${shop}/products/${product.id}.json`, { method: 'DELETE' }).catch(
      (e) => console.error('printify cleanup failed', e.message)
    );
  }
}

// --- Lulu -----------------------------------------------------------------------

const LULU_API = (env.LULU_API || 'https://api.sandbox.lulu.com').replace(/\/$/, '');

// Client-credentials token, reused until shortly before it expires.
let luluToken = null;
async function luluAuth() {
  if (!env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) {
    throw new HttpError(503, 'LULU_CLIENT_KEY and LULU_CLIENT_SECRET are not set');
  }
  if (luluToken && luluToken.expires > Date.now()) return luluToken.value;
  const basic = Buffer.from(`${env.LULU_CLIENT_KEY}:${env.LULU_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${LULU_API}/auth/realms/glasstree/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Lulu auth failed (${res.status})`);
  luluToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return luluToken.value;
}

const lulu = async (path, opts) => api(LULU_API, await luluAuth(), path, opts);

// Paperback pod_package_id: trim + color + quality + binding + paper + finish.
const LULU_PAPERS = {
  'bw-white': 'BW.STD.PB.060UW444.MXX',
  'bw-cream': 'BW.STD.PB.060UC444.MXX',
  color: 'FC.STD.PB.080CW444.MXX',
};
function luluPackage(trimWidth, trimHeight, paper) {
  const code = LULU_PAPERS[paper];
  if (!code) throw new HttpError(400, `Unknown paper "${paper}"`);
  const dim = (inches) => String(Math.round(inches * 100)).padStart(4, '0');
  return `${dim(trimWidth)}X${dim(trimHeight)}.${code}`;
}

async function luluCheckCover(body) {
  // Polotno's PDF data URL carries a filename parameter before base64.
  const pdf = String(body?.pdf || '').replace(/^data:application\/pdf[^,]*,/, '');
  if (!pdf.startsWith('JVBER')) throw new HttpError(400, 'pdf is not a PDF');
  const pageCount = Math.round(Number(body.pageCount));
  if (!(pageCount > 0)) throw new HttpError(400, 'pageCount is required');
  const pod_package_id = luluPackage(Number(body.trimWidth), Number(body.trimHeight), body.paper || 'bw-white');

  const dimensionsBody = { pod_package_id, interior_page_count: pageCount, unit: 'inch' };
  const expected = await lulu('/cover-dimensions/', { method: 'POST', body: dimensionsBody });

  const validateBody = { source_url: hostFile(pdf, 'pdf'), pod_package_id, interior_page_count: pageCount };
  let check = await lulu('/validate-cover/', { method: 'POST', body: validateBody });

  // Lulu normalizes the file asynchronously: the create response has no
  // status yet, then NORMALIZING, then NORMALIZED or ERROR. Poll until it
  // settles.
  const started = Date.now();
  const pending = (c) => !c.status || c.status === 'NORMALIZING';
  while (pending(check) && Date.now() - started < 90 * 1000) {
    await sleep(3000);
    check = await lulu(`/validate-cover/${check.id}/`);
  }

  return {
    pod_package_id,
    expected,
    validation: { status: check.status, errors: check.errors || [] },
    requests: [
      {
        title: 'Ask Lulu for the cover size',
        endpoint: `POST ${LULU_API}/cover-dimensions/`,
        body: dimensionsBody,
        response: expected,
      },
      {
        title: 'Validate the cover PDF',
        endpoint: `POST ${LULU_API}/validate-cover/`,
        body: validateBody,
        response: { status: check.status, errors: check.errors || [] },
      },
    ],
  };
}

// --- Teemill --------------------------------------------------------------------

// Teemill's Custom Product endpoint takes one image and returns a product
// page on your Teemill store. Men's Basic T-shirt, in the demo's colours.
const TEEMILL_ITEM = 'RNA1';
const TEEMILL_COLORS = { black: 'Black', blue: 'Bright Blue', red: 'Red' };

// Teemill doesn't publish a print file size for this endpoint; it scales the
// image to the print area. Export large enough to print sharp.
const teemillPrintArea = async () => ({
  areas: { front: { width: 3510, height: 3740 } },
  fromCatalog: false,
  request: 'POST https://teemill.com/omnis/v3/product/create',
});

async function teemillProduct(body) {
  if (!env.TEEMILL_PUBLIC_KEY) throw new HttpError(503, 'TEEMILL_PUBLIC_KEY is not set');
  const sides = readSides(body);
  if (!sides.front) throw new HttpError(400, 'Teemill takes the front design; add some artwork to the front');
  const colours = TEEMILL_COLORS[body.color] || 'Black';
  const productBody = {
    image_url: `data:image/png;base64,${sides.front}`,
    item_code: TEEMILL_ITEM,
    colours,
    name: 'Polotno demo tee',
    price: 20.0,
  };
  const res = await fetch('https://teemill.com/omnis/v3/product/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TEEMILL_PUBLIC_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(productBody),
  });
  const product = await res.json().catch(() => ({}));
  if (!res.ok || !product.url) throw new HttpError(502, `Teemill product create failed (${res.status})`);
  return {
    productUrl: product.url,
    mockups: [{ side: `front, ${colours}`, url: product.colours?.[colours] || product.image }],
    requests: [
      {
        title: 'Create the product from the design',
        endpoint: 'POST https://teemill.com/omnis/v3/product/create',
        body: { ...productBody, image_url: '<base64 PNG>' },
      },
    ],
  };
}

// --- Fourthwall ----------------------------------------------------------------

const FW_API = 'https://api.fourthwall.com/open-api/v1.0';
// Gildan Lightweight Fashion T-Shirt, DTG: Fourthwall renders its mockups.
const FW_TEMPLATE = env.FOURTHWALL_TEMPLATE_ID || 'pro_5786d059adeb42899b';
const FW_COLORS = { black: 'Black', blue: 'Royal Blue', red: 'Red' };
// The demo's sides, mapped to the template's regions.
const FW_REGIONS = { front: 'front_large', back: 'back' };

const fourthwall = (path, opts = {}) => {
  if (!env.FOURTHWALL_USERNAME || !env.FOURTHWALL_PASSWORD) {
    throw new HttpError(503, 'FOURTHWALL_USERNAME and FOURTHWALL_PASSWORD are not set');
  }
  const basic = Buffer.from(`${env.FOURTHWALL_USERNAME}:${env.FOURTHWALL_PASSWORD}`).toString('base64');
  return api(FW_API, basic, path, { ...opts, headers: { Authorization: `Basic ${basic}`, ...opts.headers } });
};

const fourthwallTemplate = cached(() => fourthwall(`/product-templates/${FW_TEMPLATE}`));

async function fourthwallPrintArea() {
  const template = await fourthwallTemplate('template');
  const areas = {};
  for (const [side, regionId] of Object.entries(FW_REGIONS)) {
    const d = template.customizableAreas.find((a) => a.regionId === regionId)?.dimensions;
    if (d) areas[side] = { width: d.pixelsWidth, height: d.pixelsHeight, dpi: d.dpi };
  }
  return { template: template.name, areas, request: `GET ${FW_API}/product-templates/${FW_TEMPLATE}` };
}

/** Width and height from a PNG's header. */
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function fourthwallMockups(body) {
  const sides = readSides(body);
  const color = FW_COLORS[body.color] || 'Black';

  const regions = [];
  for (const [side, base64] of Object.entries(sides)) {
    const png = Buffer.from(base64, 'base64');
    const upload = await fourthwall('/media/upload-url', {
      method: 'POST',
      body: { fileName: `polotno-demo-${side}.png`, contentType: 'image/png', size: png.length },
    });
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'x-goog-content-length-range': `0,${png.length}` },
      body: png,
    });
    if (!put.ok) throw new HttpError(502, `Fourthwall upload failed (${put.status})`);
    const image = await fourthwall('/media/images', {
      method: 'POST',
      body: { fileUrl: upload.fileUrl, ...pngSize(png) },
    });
    regions.push({ region: FW_REGIONS[side], imageId: image.id, placementStrategy: 'FULL_REGION' });
  }

  const productBody = {
    type: 'design',
    productTemplateId: FW_TEMPLATE,
    name: 'Polotno demo tee',
    description: 'Created by the Polotno SDK demo and deleted right after.',
    colors: [color],
    regions,
    publishOnCreate: false,
  };
  const product = await fourthwall('/products', { method: 'POST', body: productBody });

  try {
    const wanted = regions.map((r) => (r.region === 'front_large' ? 'front' : r.region));
    const mockups = (product.images || [])
      .filter((img) => img.color === color && wanted.includes(img.region))
      .map((img) => ({ side: `${img.region}, ${color}`, url: img.url }));
    return {
      mockups,
      requests: [
        {
          title: 'Upload each side, then register it as an image',
          endpoint: `POST ${FW_API}/media/upload-url → PUT → POST ${FW_API}/media/images`,
          body: { fileName: 'polotno-demo-front.png', contentType: 'image/png', size: '<bytes>' },
        },
        {
          title: 'Create the design product (hidden)',
          endpoint: `POST ${FW_API}/products`,
          body: productBody,
        },
      ],
    };
  } finally {
    // The demo only needs the mockups; keep the shop clean.
    fourthwall(`/products/${product.productId}`, { method: 'DELETE' }).catch((e) =>
      console.error('fourthwall cleanup failed', e.message)
    );
  }
}

// --- Spreadconnect ----------------------------------------------------------------

const SC_API = 'https://api.spreadconnect.app';
// Men's Premium T-Shirt. Spreadconnect previews only work on its hotspots.
const SC_PRODUCT = Number(env.SPREADCONNECT_PRODUCT_TYPE || 812);
const SC_COLORS = { black: '2', blue: '317', red: '366' };
const SC_HOTSPOTS = { front: 'FULL_FRONT', back: 'FULL_BACK' };
// Exported at 150 DPI; Spreadconnect takes PNG under 10 MB.
const SC_DPI = 150;

function scKey() {
  if (!env.SPREADCONNECT_LIVE_API_KEY) throw new HttpError(503, 'SPREADCONNECT_LIVE_API_KEY is not set');
  return env.SPREADCONNECT_LIVE_API_KEY;
}
const spreadconnect = (path, opts = {}) =>
  api(SC_API, '', path, { ...opts, headers: { Authorization: undefined, 'X-SPOD-ACCESS-TOKEN': scKey(), ...opts.headers } });

const scProduct = cached(() => spreadconnect(`/productTypes/${SC_PRODUCT}`));

async function spreadconnectPrintArea() {
  const product = await scProduct('product');
  const areas = {};
  for (const [side, view] of [['front', 'FRONT'], ['back', 'BACK']]) {
    const a = product.printAreas.find((p) => p.view === view);
    if (a) areas[side] = { width: Math.round(a.widthInch * SC_DPI), height: Math.round(a.heightInch * SC_DPI), dpi: SC_DPI };
  }
  return { product: product.customerName?.trim(), areas, request: `GET ${SC_API}/productTypes/${SC_PRODUCT}` };
}

async function spreadconnectMockups(body) {
  const sides = readSides(body);
  const appearanceId = SC_COLORS[body.color] || '2';
  const configurations = [];
  for (const [side, base64] of Object.entries(sides)) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }), `polotno-demo-${side}.png`);
    const res = await fetch(`${SC_API}/designs/upload`, { method: 'POST', headers: { 'X-SPOD-ACCESS-TOKEN': scKey() }, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.designId) throw new HttpError(502, `Spreadconnect upload failed (${res.status})`);
    configurations.push({ designId: json.designId, hotspot: SC_HOTSPOTS[side] });
  }
  const previewBody = { appearanceId, width: 600, height: 600, configurations };
  const preview = await spreadconnect(`/productTypes/${SC_PRODUCT}/previews`, { method: 'POST', body: previewBody });
  const wanted = configurations.map((c) => (c.hotspot === 'FULL_BACK' ? 'BACK' : 'FRONT'));
  const mockups = (preview.images || [])
    .filter((img) => wanted.includes(img.viewName))
    .map((img) => ({ side: img.viewName.toLowerCase(), url: img.url }));
  return {
    mockups,
    requests: [
      { title: 'Upload each side', endpoint: `POST ${SC_API}/designs/upload`, body: { file: '<PNG, under 10 MB>' } },
      { title: 'Get product previews', endpoint: `POST ${SC_API}/productTypes/${SC_PRODUCT}/previews`, body: previewBody },
    ],
  };
}

// --- Peecho -----------------------------------------------------------------------

const PEECHO_API = (env.PEECHO_API || 'https://test.www.peecho.com/rest/v3').replace(/\/$/, '');
// Fine Art Print A3, 297 × 420 mm: a one-page product, so one PDF page.
const PEECHO_OFFERING = Number(env.PEECHO_OFFERING_ID || 1318687);

function peechoKey() {
  if (!env.PEECHO_API_KEY) throw new HttpError(503, 'PEECHO_API_KEY is not set');
  return env.PEECHO_API_KEY;
}

async function peechoJson(path, opts) {
  const res = await fetch(PEECHO_API + path, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new HttpError(502, `Peecho ${path.split('?')[0]} failed (${res.status}): ${json.message || json.error || text.slice(0, 200)}`);
  }
  return json;
}

const peechoProduct = cached(async () => {
  const list = await peechoJson(`/offering/list?merchantApiKey=${encodeURIComponent(peechoKey())}&categoryFilter=WA`);
  for (const subs of Object.values(list)) {
    for (const items of Object.values(subs)) {
      const item = items.find((i) => i.id === PEECHO_OFFERING);
      if (item) return item;
    }
  }
  throw new HttpError(502, `Peecho offering ${PEECHO_OFFERING} is not active in this account`);
});

async function peechoProductInfo() {
  const p = await peechoProduct('product');
  return {
    id: p.id,
    name: p.name,
    widthMm: p.dimensionWidth,
    heightMm: p.dimensionHeight,
    price: p.pricingDto,
    request: `GET ${PEECHO_API}/offering/list`,
  };
}

async function peechoOrder(body) {
  const pdf = String(body?.pdf || '').replace(/^data:application\/pdf[^,]*,/, '');
  if (!pdf.startsWith('JVBER')) throw new HttpError(400, 'pdf is not a PDF');
  const product = await peechoProduct('product');

  const orderBody = {
    merchant_api_key: peechoKey(),
    currency: 'EUR',
    order_reference: `polotno-demo-${Date.now()}`,
    // A list, although Peecho's docs describe a single object.
    item_details: [{
      title: 'Polotno demo print',
      item_reference: 'polotno-demo-print', // required in practice, though the docs mark it optional
      offering_id: product.id,
      quantity: 1,
      file_details: {
        content_url: hostFile(pdf, 'pdf'),
        content_width: product.dimensionWidth,
        content_height: product.dimensionHeight,
        number_of_pages: 1,
      },
    }],
    address_details: {
      email_address: 'demo@polotno.com',
      shipping_address: {
        first_name: 'Polotno',
        last_name: 'Demo',
        address_line_1: 'Keizersgracht 1',
        address_line_2: '-',
        zip_code: '1015 CJ',
        city: 'Amsterdam',
        country_code: 'NL',
      },
    },
  };
  const order = await peechoJson('/order/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderBody),
  });
  const orderId = order.order_id ?? order.orderId ?? order.id;
  const details = orderId
    ? await peechoJson(`/order/details?merchantApiKey=${encodeURIComponent(peechoKey())}&orderId=${orderId}`).catch(() => null)
    : null;

  return {
    product: { name: product.name, widthMm: product.dimensionWidth, heightMm: product.dimensionHeight },
    order,
    details,
    requests: [
      {
        title: 'Create the order with the print PDF',
        endpoint: `POST ${PEECHO_API}/order/`,
        body: { ...orderBody, merchant_api_key: '<your merchant API key>' },
        response: order,
      },
    ],
  };
}

// --- rate limit -----------------------------------------------------------------

const hits = new Map();
function rateLimit(ip, limit = 12, windowMs = 60 * 1000) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) throw new HttpError(429, 'Too many requests, try again in a minute');
  recent.push(now);
  hits.set(ip, recent);
}

// --- server ---------------------------------------------------------------------

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /printful/print-area': (_, q) => printfulPrintArea(q),
  'POST /printful/mockups': (body) => printfulMockups(body),
  'GET /printify/print-area': (_, q) => printifyPrintArea(q),
  'POST /printify/mockups': (body) => printifyMockups(body),
  'POST /lulu/check-cover': (body) => luluCheckCover(body),
  'GET /teemill/print-area': () => teemillPrintArea(),
  'POST /teemill/product': (body) => teemillProduct(body),
  'GET /fourthwall/print-area': () => fourthwallPrintArea(),
  'POST /fourthwall/mockups': (body) => fourthwallMockups(body),
  'GET /spreadconnect/print-area': () => spreadconnectPrintArea(),
  'POST /spreadconnect/mockups': (body) => spreadconnectMockups(body),
  'GET /peecho/product': () => peechoProductInfo(),
  'POST /peecho/order': (body) => peechoOrder(body),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Design too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'Body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const file = url.pathname.match(/^\/files\/([0-9a-f-]+)\.(png|pdf)$/);
  if (req.method === 'GET' && file) {
    const f = files.get(file[1]);
    if (!f || f.ext !== file[2]) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': FILE_TYPES[f.ext] }).end(f.data);
  }

  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (!route) throw new HttpError(404, 'Not found');
    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0]
        .trim();
      rateLimit(ip);
    }
    const body = req.method === 'POST' ? await readBody(req) : null;
    const result = await route(body, url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(req.method, url.pathname, e.message);
    res
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`pod-proxy listening on ${PORT}`));
