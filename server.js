require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { request, gql } = require("graphql-request");
const crypto = require('crypto'); // Import crypto for generating a random ID

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


// --- API Endpoints ---

// Step 1: Start an auth session (user scans QR)
app.get("/start-auth", async (req, res) => {
  // Using the CreateAuthSession mutation structure confirmed by cURL example
  // Takes input object { externalId }, returns id, qr, expiresIn
  const mutation = gql`
    mutation CreateAuthSession($input: CreateAuthSessionInput!) { # Takes input object
      CreateAuthSession(input: $input) {                         # Passes input object
        id                                                        # Auth Session ID
        qr                                                        # QR Code Data URI
        expiresIn                                                 # Expiry time
      }
    }
  `;

  try {
    console.log("Requesting auth session from Enjin Platform (cURL structure)...");
    // Create a unique externalId (optional but recommended)
    const externalId = `rps-session-${crypto.randomUUID()}`;
    const variables = {
        input: { // Pass externalId inside the input object
            externalId: externalId
        }
    };
    console.log("Using variables:", JSON.stringify(variables)); // Log variables being sent

    const data = await request({
      url: PLATFORM_URL,
      document: mutation,
      variables: variables, // Pass the structured variables
      requestHeaders: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    // Access the data based on the mutation name
    const authData = data?.CreateAuthSession;

    // Check for the fields returned according to cURL example (id, qr)
    if (!authData?.id || !authData?.qr) {
        console.error("Unexpected response structure from CreateAuthSession (cURL structure):", data);
        // Log the actual fields received if possible
        console.error("Received fields:", Object.keys(authData || {}).join(', '));
        throw new Error("Failed to get required ID or QR code from auth response.");
    }

    console.log("Auth session created successfully (cURL structure):", authData);
    // Return the data containing id, qr, and expiresIn
    res.json(authData); // This should contain the direct QR data URI

  } catch (err) {
    console.error("Auth error:", err.response?.errors || err.message);
     if (err.response?.errors) {
        console.error("GraphQL Errors:", JSON.stringify(err.response.errors, null, 2));
     } else if (err.response?.error) {
         // Log the raw error if it's not a typical GraphQL error structure (like the HTML page)
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
