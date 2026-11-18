# EmberTip — BCH payment pages in 30 seconds

**BCH BLAZE 2026 · Mainnet Track submission**

EmberTip lets anyone create a beautiful Bitcoin Cash payment page in seconds —
no server, no account, no custody. Share the link or QR code; visitors pay real
BCH on mainnet with any wallet (scan) or with a connected wallet via
WizardConnect. Incoming payments appear live on the page.

## Why

Getting paid in BCH today still means pasting a raw address into chats and
hoping the other side knows what to do. EmberTip turns an address into a
proper payment page: named, branded, with preset amounts, a memo, one-tap
wallet payment and a live receipt feed. It is the "link-in-bio for BCH money".

## How it works

- **Create** — enter a name, your BCH address, preset amounts and a note.
  The page configuration is encoded into the share link itself; nothing is
  uploaded anywhere. Your page works from any static host, forever.
- **Pay** — visitors either scan the BIP-21 QR code with any BCH wallet
  (Selene, Paytaca, XO, …) or connect a wallet with WizardConnect and sign a
  real mainnet transaction in one tap.
- **Watch** — the page polls the chain (Watchtower via mainnet-js) and shows
  incoming payments live, with amounts, times and explorer links.

Non-custodial by design: EmberTip never sees a private key. Page owners keep
their own wallet; payers sign in their own wallet.

## Tech

- Static single-page app (vanilla JS ES modules, no build step)
- [mainnet-js](https://mainnet.cash) for address watching / history
- [WizardConnect](https://docs.riftenlabs.com/wizardconnect/) (`@wizardconnect/dapp`)
  for HD-wallet connection and transaction signing
- libauth for address validation, qrcode-generator for BIP-21 QR codes

## Run locally

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

## Hackathon requirements mapping

- ✅ Sends real BCH **mainnet** transactions (wallet-signed via WizardConnect,
  or any wallet via BIP-21 QR)
- ✅ Live clickable demo (GitHub Pages)
- ✅ WizardConnect integration for BCH wallet connection
- ✅ Top banner: presentation link, repository link, CashTokens address for
  EMBER2026 donations (Community Choice)
- ✅ Original project, built during BCH BLAZE 2026

MIT License.
