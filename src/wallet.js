// WizardConnect integration (Riften Labs) — HD-wallet connection over an
// encrypted Nostr relay. The dapp never touches private keys: the user's
// wallet (e.g. Paytaca) holds the keys, reviews and signs.
//
// API surface verified against @wizardconnect/core 0.2.10 /
// @wizardconnect/dapp 0.2.7 type definitions:
//   initiateDappRelay(statusCallback) -> { uri, qrUri, credentials, cleanup }
//   new DappConnectionManager(name); manager.attachRelay(relay);
//   manager.updateConnection(client, status)  (from the relay status callback)
//   manager.on("walletready", ...)            (session established)
//   manager.getPubkey(childIndex, index)      (0 = receive, 1 = change)
//   manager.signTransaction({ transaction, inputPaths }) -> { signedTransaction }

import { initiateDappRelay } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";
import * as libauth from "@bitauth/libauth";

let manager = null;
let relay = null;
let connected = false;

async function loadLibauth() {
  return libauth;
}

export function wizardConnected() {
  return connected;
}

/** Derive the cashaddr for a raw 33-byte pubkey (P2PKH). */
export async function pubkeyToCashaddr(pubkey) {
  const la = await loadLibauth();
  const hash = la.ripemd160.hash(la.sha256.hash(pubkey));
  const result = la.encodeCashAddress({
    prefix: "bitcoincash",
    type: "p2pkh",
    payload: hash,
  });
  return typeof result === "string" && result.startsWith("bitcoincash:")
    ? result
    : result?.address ?? result;
}

/** The connected wallet's receive address at index i (0-based). */
export async function wizardAddress(index = 0) {
  if (!manager) return null;
  const pub = manager.getPubkey(0, BigInt(index));
  if (!pub) return null;
  return pubkeyToCashaddr(pub);
}

/**
 * Start a WizardConnect session.
 * @param {(uri: string) => void} onUri pairing URI (render as QR / link)
 * @param {(msg: string) => void} onStatus
 * @returns {Promise<{paths: Array<{name: string, xpub: string}>}>}
 */
export async function connectWizard(onUri, onStatus) {
  manager = new DappConnectionManager("EmberTip");
  relay = initiateDappRelay((client, status) => {
    try { manager.updateConnection(client, status); } catch { /* ignore */ }
  });
  manager.attachRelay(relay);
  if (onUri) onUri(relay.qrUri || relay.uri);
  onStatus("Scan the pairing code with a WizardConnect wallet (e.g. Paytaca) and approve…");

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Wallet did not respond within 3 minutes.")),
      180000
    );
    manager.once("walletready", () => { clearTimeout(timeout); resolve(); });
    manager.once("disconnect", (reason, message) => {
      clearTimeout(timeout);
      reject(new Error(`Wallet disconnected: ${message || reason || "unknown reason"}`));
    });
  });

  connected = true;
  const paths = manager.getSessionPaths ? manager.getSessionPaths() : [];
  onStatus("Wallet connected.");
  return { paths };
}

export async function disconnectWizard() {
  try { await manager?.destroy?.(); } catch { /* ignore */ }
  try { relay?.cleanup?.(); } catch { /* ignore */ }
  manager = null;
  relay = null;
  connected = false;
}

// ── Payment ────────────────────────────────────────────────────────────────
// Builds a plain P2PKH payment from the connected wallet's own UTXOs and
// asks the wallet to sign it (WizardConnect hdwalletv1). The unlocking
// bytecode template carries the real pubkey and a 65-byte signature
// placeholder (64 zero bytes + SIGHASH_ALL|FORKID byte) that the wallet
// replaces with the real signature — the standard BCH WalletConnect
// transaction format. broadcast:true asks the wallet to broadcast.

const DUST = 546n;

function p2pkhLockingBytecode(payloadHash160) {
  return Uint8Array.from([
    0x76, 0xa9, 0x14, ...payloadHash160, 0x88, 0xac,
  ]);
}

function unlockingTemplate(pubkey) {
  const sigPlaceholder = new Uint8Array(65);
  sigPlaceholder[64] = 0x41; // SIGHASH_ALL | SIGHASH_FORKID
  return Uint8Array.from([
    0x41, ...sigPlaceholder, // push 65-byte signature placeholder
    0x21, ...pubkey,         // push 33-byte pubkey
  ]);
}

/**
 * @param {object} args
 * @param {string} args.toCashaddr recipient cashaddr
 * @param {bigint} args.amountSats amount to send
 * @param {(address: string) => Promise<Array<{txid: string, index: number, value: number, pkscript: string}>>} args.fetchUtxos
 *   UTXO source (Haskoin /unspent shape)
 * @param {(msg: string) => void} args.onStatus
 * @returns {Promise<{txid: string, signedTransaction: string}>}
 */
export async function wizardPay({ toCashaddr, amountSats, fetchUtxos, onStatus }) {
  if (!manager || !connected) throw new Error("Wallet is not connected.");
  const la = await loadLibauth();

  const decoded = la.decodeCashAddress(toCashaddr);
  if (typeof decoded === "string" || !decoded?.payload) {
    throw new Error("Invalid recipient address.");
  }
  const payLocking = p2pkhLockingBytecode(decoded.payload);

  // 1. Scan receive addresses 0..19 for spendable UTXOs.
  onStatus("Scanning wallet addresses for funds…");
  const candidates = [];
  let total = 0n;
  const feeEstimate = (nIn, nOut) => BigInt(Math.ceil((10 + 148 * nIn + 34 * nOut) * 1.05));
  outer: for (let i = 0; i < 20; i++) {
    const pub = manager.getPubkey(0, BigInt(i));
    if (!pub) break;
    const addr = await pubkeyToCashaddr(pub);
    const utxos = await fetchUtxos(addr).catch(() => []);
    for (const u of utxos) {
      candidates.push({ ...u, pubkey: pub, chainName: "receive", index: i });
      total += BigInt(u.value);
      if (total >= amountSats + feeEstimate(candidates.length, 2)) break outer;
    }
  }
  if (candidates.length === 0) {
    throw new Error("No funds found on the connected wallet's first 20 receive addresses.");
  }
  const fee = feeEstimate(candidates.length, 2);
  if (total < amountSats + fee) {
    throw new Error(
      `Insufficient funds: found ${(Number(total) / 1e8).toFixed(8)} BCH, need ${((Number(amountSats + fee)) / 1e8).toFixed(8)} BCH incl. fee.`
    );
  }

  // 2. Outputs: payment + change (to the wallet's first change address).
  const changeTotal = total - amountSats - fee;
  const outputs = [{ lockingBytecode: payLocking, valueSatoshis: amountSats }];
  if (changeTotal > DUST) {
    const changePub = manager.getPubkey(1, 0n);
    if (changePub) {
      const changeHash = la.ripemd160.hash(la.sha256.hash(changePub));
      outputs.push({ lockingBytecode: p2pkhLockingBytecode(changeHash), valueSatoshis: changeTotal });
    }
  }

  // 3. Inputs + source outputs + HD paths.
  const inputs = candidates.map((u) => ({
    outpointTransactionHash: la.hexToBin(u.txid).slice().reverse(),
    outpointIndex: u.index,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: unlockingTemplate(u.pubkey),
  }));
  const sourceOutputs = candidates.map((u, i) => ({
    ...inputs[i],
    lockingBytecode: la.hexToBin(u.pkscript),
    valueSatoshis: BigInt(u.value),
  }));
  const inputPaths = candidates.map((u) => [0, u.chainName, u.index]);

  const transaction = {
    version: 2,
    locktime: 0,
    inputs,
    outputs,
  };

  // 4. Ask the wallet to sign (and broadcast).
  onStatus("Review and approve the payment in your wallet…");
  const response = await manager.signTransaction({
    transaction: {
      transaction,
      sourceOutputs,
      broadcast: true,
      userPrompt: `EmberTip payment of ${(Number(amountSats) / 1e8).toFixed(8)} BCH`,
    },
    inputPaths,
  });
  if (response.error) throw new Error(`Wallet refused: ${response.error}`);

  const signedBin = la.hexToBin(response.signedTransaction);
  const txid = la.binToHex(
    la.sha256.hash(la.sha256.hash(signedBin)).slice().reverse()
  );
  return { txid, signedTransaction: response.signedTransaction };
}
