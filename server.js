require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");

const app = express();
// Use the PORT environment variable provided by Render or default to 5000
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json());

// --- Configuration ---
const PLATFORM_URL = process.env.PLATFORM_URL;
const AUTH_TOKEN = process.env.ENJIN_API_TOKEN; // Ensure this is set in Render Env Vars
// Removed unused constants related to minting
// const COLLECTION_ID = parseInt(process.env.COLLECTION_ID);
// const RECEIVER_WALLET = process.env.RECEIVER_WALLET;
// const TOKEN_IDS = [1, 2, 3];
// const TOKEN_NAMES = { 1: "Rock", 2: "Paper", 3: "Scissors" };
// const MINT_COUNT = 5;
// const MINT_COST_ENJ = "10";
// const MINT_COST_WITOSHI = (BigInt(MINT_COST_ENJ) * BigInt(10 ** 18)).toString();
// const TX_POLL_INTERVAL_MS = 3000; // Kept for check-auth polling interval on frontend
// const TX_POLL_TIMEOUT_MS = 120000;


// --- Helper Functions (Removed unused ones) ---
// function getRandomTokenId() { ... }
// function delay(ms) { ... } // No longer needed in backend


// --- API Endpoints ---

// Step 1: Start an auth session (user scans QR)
app.get("/start-auth", async (req, res) => {
  // Using the verified mutation name 'CreateAuthSession'
  const mutation = gql`
    mutation CreateAuthSession($input: CreateAuthSessionInput!) {
      CreateAuthSession(input: $input) {
        id                # Auth Session ID
        state             # Initial state (e.g., PENDING)
        authenticationUrl # URL to be encoded into QR code by frontend
      }
    }
  `;

  try {
    console.log("Requesting auth session from Enjin Platform...");
    const variables = { input: {} }; // Empty input is valid
    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      variables: variables,
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    const authData = data?.CreateAuthSession;

    if (!authData?.id || !authData?.authenticationUrl) {
        console.error("Unexpected response structure from CreateAuthSession:", data);
        throw new Error("Failed to get required ID or authenticationUrl from auth response.");
    }

    console.log("Auth session created successfully:", authData);
    // Return the data containing id, state, and authenticationUrl
    res.json(authData);

  } catch (err) {
    console.error("Auth error:", err.response?.errors || err.message);
     if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
     } else if (err.response?.error) {
         console.error("Raw API Error Response:", err.response.error);
     }
    res.status(500).json({ error: "Auth failed", details: err.message });
  }
});

// Step 2: Check Authentication Status (Polling)
app.get("/check-auth/:authSessionId", async (req, res) => { // Use authSessionId
    const { authSessionId } = req.params;
    if (!authSessionId) {
        return res.status(400).json({ error: "Auth session ID is required" });
    }

    // Using the verified query 'GetAuthSession'
    const query = gql`
      query GetAuthSession($id: ID!) {
        GetAuthSession(id: $id) {
          id
          state
          wallet {
            id # CAIP-10 wallet ID
          }
        }
      }
    `;

    try {
      const data = await request({
        url: PLATFORM_URL,
        document: query,
        variables: { id: authSessionId }, // Use ID! type
        requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });

      const sessionData = data?.GetAuthSession;
      const walletId = sessionData?.wallet?.id;
      const sessionState = sessionData?.state;
      console.log(`Polling auth session ${authSessionId}: State=${sessionState}, Wallet=${walletId || 'N/A'}`);

      // Return address only if wallet ID exists (implies successful link)
      if (walletId) {
        res.json({ address: walletId });
      } else {
        res.json({ address: null }); // Not authenticated or wallet not linked yet
      }
    } catch (err) {
      if (err.response?.errors) {
          console.error("Check auth GraphQL error:", err.response.errors);
          if (err.response.errors.some(e => e.message.includes("not found"))) {
             return res.status(404).json({ address: null, error: "Auth session not found or expired." });
          }
      } else {
          console.error("Check auth network/request error:", err.message);
      }
      res.status(200).json({ address: null, error: "Failed to check auth status or wallet not linked." });
    }
});


// Step 3: Mint endpoint REMOVED
// app.post("/mint", async (req, res) => { ... });


// --- Other Endpoints (Balances, Supply) - Kept for potential use ---
// NOTE: These also use GraphQL queries ('TokensByOwner', 'Tokens') that should be verified against the API schema.
app.get("/balances/:wallet", async (req, res) => {
    const { wallet } = req.params;
    if (!wallet) { return res.status(400).json({ error: "Wallet address required." }); }
    const query = gql` query GetTokensByOwner($collectionId: BigInt!, $wallet: String!) { TokensByOwner(collectionId: $collectionId, address: $wallet) { tokenId balance } } `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0'); // Added default to avoid error if not set
    const TOKEN_IDS = [1, 2, 3]; // Keep for filtering balances
    try {
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID, wallet }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        const balances = {};
        if (data?.TokensByOwner && Array.isArray(data.TokensByOwner)) {
            data.TokensByOwner.forEach(({ tokenId, balance }) => {
                if (TOKEN_IDS.includes(parseInt(tokenId, 10))) { balances[tokenId] = parseInt(balance, 10); }
            });
        } else { console.warn(`No TokensByOwner data found for wallet ${wallet}`); }
        res.json(balances);
    } catch (err) { console.error("Balance fetch error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not get balances", details: err.message }); }
});

app.get("/supply", async (req, res) => {
    const query = gql` query GetCollectionTokens($collectionId: BigInt!) { Tokens(collectionId: $collectionId, filter: { tokenId_in: ["1", "2", "3"] }) { tokenId totalSupply } } `;
    const COLLECTION_ID = parseInt(process.env.COLLECTION_ID || '0'); // Added default
    const TOKEN_IDS = [1, 2, 3]; // Keep for calculating total
    const MAX_SUPPLY_PER_TOKEN = 50;
    const TOTAL_POSSIBLE = MAX_SUPPLY_PER_TOKEN * TOKEN_IDS.length;
    try {
        const data = await request({ url: PLATFORM_URL, document: query, variables: { collectionId: COLLECTION_ID }, requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` } });
        let totalMinted = 0;
        if (data?.Tokens && Array.isArray(data.Tokens)) { totalMinted = data.Tokens.reduce((sum, t) => sum + parseInt(t.totalSupply || '0', 10), 0); }
        else { console.warn("Could not accurately determine total minted supply from Tokens query."); }
        const remaining = TOTAL_POSSIBLE - totalMinted;
        res.json({ remaining: Math.max(0, remaining) });
    } catch (err) { console.error("Supply error:", err.response?.errors || err.message); res.status(500).json({ error: "Could not fetch supply", details: err.message }); }
});

// Basic root route (optional)
app.get("/", (req, res) => {
    res.send("RPS Auth Backend is running."); // Updated message
});
