# Polotno print-on-demand demo

A t-shirt customizer built with [Polotno SDK](https://polotno.com). Customers design the front and back of a shirt in the browser. The app exports print files at the size Printful or Printify asks for, sends them to that provider's API, and shows the mockups the provider renders. With Teemill, it turns the design into a real product page.

Try it live: [with Printful](https://polotno.com/sdk/product/integrations/printful) · [with Printify](https://polotno.com/sdk/product/integrations/printify) · [with Teemill](https://polotno.com/sdk/product/integrations/teemill) · [with Fourthwall](https://polotno.com/sdk/product/integrations/fourthwall)

## How it works

1. The server reads the tee's print area from the provider's catalog, so the dashed box on the shirt matches the real print file.
2. The customer designs inside that box. Polotno exports one transparent PNG per side at the provider's pixel size.
3. The server sends the files on. For Printful it creates a mockup task and waits for the result. For Printify it uploads the images, creates a draft product, reads its mockups and deletes the draft. For Teemill it sends the front design to the Custom Product endpoint, which returns a buyable product page. For Fourthwall it uploads each side, creates a hidden design product, reads its mockups and archives it.
4. Nothing is ordered. Each response includes the order or product request you would send to make it real.

## Run it

You need Node 20+, pnpm, a Polotno API key (free for development at [polotno.com/cabinet](https://polotno.com/cabinet)) and a token for Printful, Printify or both.

```bash
cd server
cp .env.example .env   # add your Printful and Printify tokens
node --env-file=.env server.mjs
```

```bash
cd web
cp .env.example .env   # add your Polotno key
pnpm install
pnpm dev
```

Open `http://localhost:5173/?provider=printify`, `?provider=printful`, `?provider=teemill` or `?provider=fourthwall`. Without the parameter it is a plain customizer with PDF and PNG downloads.

The tokens stay on the server. Printful downloads print files from a public URL, so to test Printful locally, expose the server with a tunnel (for example `cloudflared tunnel --url http://localhost:8787`) and set `PUBLIC_URL` to the tunnel address.

## Where things are

- `web/src/scene.js`: the shirt photo, the print-window overlay, and the export clipped to the print area
- `web/src/provider.js`, `web/src/provider-panel.jsx`: the Printful and Printify mode
- `server/server.mjs`: the catalog lookups, Printful's mockup generator, and the Printify draft product

## License

MIT
