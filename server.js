require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

app.use(cors());
app.use(bodyParser.json());

// --- Configuration ---
const PLATFORM_URL = process.env.PLATFORM_URL;
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN;
const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0');
const RECEIVER_WALLET = process.env.RECEIVER_WALLET;

const TOKEN_IDS = [1, 2, 3]; // Available token IDs to mint randomly
const TOKEN_NAMES = { 1: "Rock", 2: "Paper", 3: "Scissors" };
const MINT_COUNT = 3; // Mint 3 tokens per pack
const MINT_COST_ENJ = "10"; // Cost in ENJ for the pack
const MINT_COST_WITOSHI = (BigInt(MINT_COST_ENJ) * BigInt(10 ** 18)).toString();
const TX_POLL_INTERVAL_MS = 3000; // Poll transaction status every 3 seconds
const TX_POLL_TIMEOUT_MS = 120000; // Wait a maximum of 2 minutes

// --- Helper Functions ---
function getRandomTokenId() {
    return TOKEN_IDS[Math.floor(Math.random() * TOKEN_IDS.length)];
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Endpoints ---

// Start wallet verification process
app.get("/start-auth", async (req, res) => {
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode
        verificationId
      }
    }
  `;
  try {
    console.log("Requesting account verification from Enjin Platform...");
    const data = await request({ url: PLATFORM_URL, document: query, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const verificationData = data?.RequestAccount;
    if (!verificationData?.verificationId || !verificationData?.qrCode) { throw new Error("Failed to get required verificationId or qrCode from RequestAccount response."); }
    console.log("Account verification request initiated:", verificationData);
    res.json(verificationData);
  } catch (err) { console.error("Verification request error:", err.response?.errors || err.message); if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); } else if (err.response?.error) { console.error("Raw API Error Response:", err.response.error); } res.status(500).json({ error: "Verification request failed", details: err.message }); }
});

// Check Authentication Status (Polling)
app.get("/check-auth/:verificationId", async (req, res) => {
    const { verificationId } = req.params;
    if (!verificationId) { return res.status(400).json({ error: "Verification ID is required" }); }
    const query = gql`
      query GetVerifiedWallet($verificationId: String!) {
        GetWallet(verificationId: $verificationId) {
          id # Internal Wallet ID
          account { address }
          balances { free }
        }
      }
    `;
    try {
      const data = await request({ url: PLATFORM_URL, document: query, variables: { verificationId: verificationId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
      const walletData = data?.GetWallet;
      const walletAddress = walletData?.account?.address;
      const enjBalanceWitoshi = walletData?.balances?.free ?? null;
      const internalWalletId = walletData?.id ?? null;
      console.log(`Polling verification ${verificationId}: WalletData=${walletData ? 'Found' : 'Null'}, Address=${walletAddress || 'N/A'}, Balance=${enjBalanceWitoshi ?? 'N/A'}, WalletID=${internalWalletId ?? 'N/A'}`);
      if (walletData && walletAddress && internalWalletId) {
          res.json({ address: walletAddress, balance: enjBalanceWitoshi, walletId: internalWalletId });
      } else { res.json({ address: null, balance: null, walletId: null }); }
    } catch (err) { if (err.response?.errors) { console.error("Check verification GraphQL error:", err.response.errors); } else { console.error("Check verification network/request error:", err.message); } res.status(200).json({ address: null, balance: null, walletId: null, error: "Failed to check verification status or not yet verified." }); }
});

// Mint Tokens Endpoint (Re-added)
app.post("/mint", async (req, res) => {
  const { verificationId } = req.body; // Expecting verificationId from frontend
  if (!verificationId) {
    return res.status(400).json({ error: "Verification ID is required" });
  }

  let userWalletAddress = null;
  let chargeTransactionId = null;

  try {
    // Re-verify and get wallet address
    console.log(`Mint request received for verificationId: ${verificationId}`);
    const getWalletQuery = gql`
      query GetVerifiedWalletForMint($verificationId: String!) {
        GetWallet(verificationId: $verificationId) {
          account { address }
        }
      }
    `;
    const { GetWallet } = await request({ url: PLATFORM_URL, document: getWalletQuery, variables: { verificationId: verificationId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    userWalletAddress = GetWallet?.account?.address;
    if (!userWalletAddress) { throw new Error(`Wallet not verified or found for verification ID ${verificationId}. Please reconnect.`); }
    console.log(`User wallet identified for minting: ${userWalletAddress}`);

    // Initiate Charge ENJ
    // UNCERTAINTY WARNING: This is the step most likely to fail if the RequestAccount flow cannot authorize transactions.
    console.log(`Requesting ${MINT_COST_ENJ} cENJ charge transaction...`);
    const txMutation = gql`
      mutation CreateTransaction($input: CreateTransactionInput!) {
        CreateTransaction(input: $input) { id, state }
      }
    `;
    const txVars = { input: { recipient: RECEIVER_WALLET, value: MINT_COST_WITOSHI, authTokenId: verificationId } };
    const chargeTxResult = await request({ url: PLATFORM_URL, document: txMutation, variables: txVars, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    chargeTransactionId = chargeTxResult?.CreateTransaction?.id;
    if (!chargeTransactionId) { throw new Error("Failed to initiate charge transaction request."); }
    console.log(`Charge transaction request created: ID=${chargeTransactionId}, State=${chargeTxResult?.CreateTransaction?.state}`);

    // Monitor Charge Transaction Status
    console.log(`Monitoring charge transaction status (ID: ${chargeTransactionId})...`);
    let chargeSucceeded = false;
    const getTxStateQuery = gql`query GetTransactionState($id: String!) { Transaction(id: $id) { state } }`;
    for (let i = 0; i < (TX_POLL_TIMEOUT_MS / TX_POLL_INTERVAL_MS); i++) {
        await delay(TX_POLL_INTERVAL_MS);
        const txStateResult = await request({ url: PLATFORM_URL, document: getTxStateQuery, variables: { id: chargeTransactionId }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        const currentState = txStateResult?.Transaction?.state;
        console.log(`Polling charge TX ${chargeTransactionId}: State = ${currentState}`);
        if (["EXECUTED", "CONFIRMED", "COMPLETED"].includes(currentState)) { chargeSucceeded = true; break; }
        if (["FAILED", "CANCELED", "REJECTED", "EXPIRED"].includes(currentState)) { throw new Error(`Payment failed or was rejected (State: ${currentState}).`); }
    }
    if (!chargeSucceeded) { throw new Error("Payment confirmation timed out."); }

    // Minting Logic
    console.log("Payment confirmed. Proceeding with minting...");
    const tokensToMintDetails = Array.from({ length: MINT_COUNT }, () => {
        const randomId = getRandomTokenId();
        return { id: randomId, name: TOKEN_NAMES[randomId] || `Token ${randomId}` };
    });
    console.log(`Generated tokens to mint: ${tokensToMintDetails.map(t => t.name).join(', ')}`);
    const batchRecipients = tokensToMintDetails.map(token => ({ account: userWalletAddress, mintParams: { amount: 1, tokenId: { integer: token.id } } }));
    const mintMutation = gql`mutation BatchMint($collectionId: BigInt!, $recipients: [BatchMintRecipientInput!]!) { BatchMint(collectionId: $collectionId, recipients: $recipients) { id, state, method } }`;
    const mintResult = await request({ url: PLATFORM_URL, document: mintMutation, variables: { collectionId: COLLECTION_ID, recipients: batchRecipients }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    console.log("Batch mint request created:", mintResult.BatchMint);

    res.json({ success: true, mintedTokens: tokensToMintDetails });
  } catch (err) {
    console.error("Mint process error:", err.response?.errors || err.message);
    if (err.response?.errors) { console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2)); }
    res.status(500).json({ error: "Mint process failed.", details: err.message });
  }
});

// Get FT balances for a specific wallet
app.get("/balances/:walletAddress", async (req, res) => {
  const { walletAddress } = req.params;
  if (!walletAddress) { return res.status(400).json({ error: "Wallet address required." }); }
  const query = gql`
    query GetWalletTokenBalances($account: String!, $collectionId: BigInt!, $tokenIds: [BigInt!]) {
      GetWallet(account: $account) {
        tokenAccounts(collectionIds: [$collectionId], tokenIds: $tokenIds) {
          edges { node { token { tokenId }, balance } }
        }
      }
    }
  `;
  try {
    console.log(`Fetching FT balances for wallet address: ${walletAddress}`);
    const data = await request({ url: PLATFORM_URL, document: query, variables: { account: walletAddress, collectionId: COLLECTION_ID, tokenIds: [1, 2, 3] }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    const balances = { "1": 0, "2": 0, "3": 0 };
    const edges = data?.GetWallet?.tokenAccounts?.edges;
    if (edges) { edges.forEach(edge => { if (edge?.node?.token?.tokenId) { balances[edge.node.token.tokenId.toString()] = parseInt(edge.node.balance, 10); } }); }
    console.log("FT Balances:", balances);
    res.json(balances);
  } catch (err) { console.error("Balance fetch error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not get balances", details: err.message }); }
});

// Get supply
app.get("/supply", async (req, res) => {
    const query = gql`
        query GetTotalFungibleSupply($collectionId: BigInt!) {
            GetCollection(collectionId: $collectionId) {
                tokens(first: 100) {
                    edges { node { tokenId, supply, capSupply } }
                }
            }
        }
    `;
    try {
        console.log(`Fetching token supply for collection: ${COLLECTION_ID}`);
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        let totalMinted = 0, totalMaxSupply = 0;
        const edges = data?.GetCollection?.tokens?.edges;
        if (edges) { edges.forEach(edge => { if (edge?.node?.tokenId && [1, 2, 3].includes(parseInt(edge.node.tokenId))) { totalMinted += parseInt(edge.node.supply || '0', 10); totalMaxSupply += parseInt(edge.node.capSupply || '0', 10); } }); }
        else { totalMaxSupply = 150; } // Fallback
        const remaining = totalMaxSupply - totalMinted;
        console.log(`Total minted: ${totalMinted}, Remaining: ${remaining}`);
        res.json({ totalMinted, totalMaxSupply, remaining: Math.max(0, remaining) });
    } catch (err) { console.error("Supply error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not fetch supply", details: err.message }); }
});

app.get("/", (req, res) => { res.send("RPS Auth Backend is running."); });
